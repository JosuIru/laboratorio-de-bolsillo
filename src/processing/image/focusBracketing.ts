/**
 * Enfoque en horquilla para la Luna: se hace una serie de fotos a distintas distancias de enfoque
 * (manual), se puntúa la nitidez de cada una y se propone una serie más fina alrededor de la
 * mejor, hasta que el paso es menor que la resolución del enfoque.
 *
 * El autofoco del móvil suele fallar con un disco de ~30 px sobre negro. La puntuación combina:
 *  - Limbo: σ de la dispersión del borde iluminado (`limbProfiles.ts`). Es el indicador más
 *    robusto: el borde es un escalón perfecto, está en todas las fases y apenas lo toca el
 *    ruido porque promedia cientos de perfiles. La puntuación es 1/σ.
 *  - Interior: varianza del laplaciano dentro del 80 % del radio (`measureLaplacianSharpness`),
 *    que mira los detalles de albedo (mares) cuando los hay.
 * Se combinan como media geométrica ponderada (suma ponderada de logaritmos): así ninguna escala
 * domina y, si el interior no tiene textura, cuenta solo el limbo.
 *
 * Búsqueda: con la mejor foto en el interior de la serie, se ajusta una parábola al logaritmo de
 * la puntuación de ella y sus dos vecinas; su vértice es la estimación del mejor enfoque, y la
 * serie siguiente cubre la mitad del intervalo entre las vecinas (el paso baja a ~1/4 del
 * anterior con 5 fotos). Si la mejor está en un extremo, la serie se desplaza hacia fuera con el
 * mismo paso.
 *
 * Las posiciones de enfoque son números en cualquier unidad (en Android, dioptrías de
 * LENS_FOCUS_DISTANCE; el infinito es 0). Módulo puro: sin React ni React Native.
 */

import type { GrayImage } from './grayImage';
import { measureLaplacianSharpness } from './luckyImaging';
import type { Circle } from './lunarDiskFit';
import {
  fitGaussianProfile,
  fitLunarDiskTolerantOfBlur,
  lineSpreadFromEdgeSpread,
  measureLimbEdgeSpread,
  samplingVariancePixelsSquared,
  defaultLimbProfileOptions,
} from './limbProfiles';

/** Peso del limbo en la puntuación combinada (el resto, el interior). */
const limbScoreWeight = 0.7;
/** Fracción del radio en que se mide la textura interior (fuera queda el borde, que ya cuenta). */
const interiorRegionRadiusFraction = 0.8;
/** σ mínimo del borde, en píxeles: por debajo el muestreo no deja distinguir. */
const minimumEdgeSigmaPixels = 0.3;

export interface LunarFocusScore {
  /** Puntuación combinada (mayor = más nítida). Solo tiene sentido comparada en una misma serie. */
  score: number;
  /** σ del borde del limbo, en píxeles (ya sin el muestreo). */
  limbEdgeSigmaPixels: number;
  /** Varianza relativa del laplaciano en el interior (0 si no se pudo medir). */
  interiorLaplacianScore: number;
  diskCircle: Circle;
}

/** Nitidez de una foto de la Luna, o `null` si no se encuentra el disco o su limbo iluminado. */
export function measureLunarFocusScore(image: GrayImage, diskCircle?: Circle | null): LunarFocusScore | null {
  const fittedCircle = diskCircle ?? fitLunarDiskTolerantOfBlur(image);
  if (!fittedCircle) return null;
  const edgeSpread = measureLimbEdgeSpread(image, fittedCircle);
  if (!edgeSpread) return null;
  const lineSpread = lineSpreadFromEdgeSpread(edgeSpread);
  const measuredSigma = fitGaussianProfile(lineSpread.offsetsPixels, lineSpread.values).sigmaPixels;
  const limbEdgeSigmaPixels = Math.max(
    minimumEdgeSigmaPixels,
    Math.sqrt(Math.max(0, measuredSigma ** 2 - samplingVariancePixelsSquared(defaultLimbProfileOptions.stepPixels))),
  );
  const interiorLaplacianScore = measureLaplacianSharpness(image, {
    centerX: fittedCircle.centerX,
    centerY: fittedCircle.centerY,
    radiusPixels: interiorRegionRadiusFraction * fittedCircle.radius,
  });
  const logLimbScore = -Math.log(limbEdgeSigmaPixels);
  const logScore =
    interiorLaplacianScore > 0
      ? limbScoreWeight * logLimbScore + (1 - limbScoreWeight) * Math.log(interiorLaplacianScore)
      : logLimbScore;
  return { score: Math.exp(logScore), limbEdgeSigmaPixels, interiorLaplacianScore, diskCircle: fittedCircle };
}

export interface FocusMeasurement {
  focusPosition: number;
  score: number;
}

export interface BestFocusEstimate {
  /** Índice (en la serie ordenada por posición) de la foto con mejor puntuación. */
  bestMeasuredIndex: number;
  bestMeasuredPosition: number;
  /** Posición estimada del óptimo (vértice de la parábola si está horquillado). */
  estimatedBestPosition: number;
  /** Hay fotos a ambos lados de la mejor, peores que ella. */
  isBracketed: boolean;
  /** Vecinas de la mejor (o la propia mejor si está en un extremo). */
  bracketLowPosition: number;
  bracketHighPosition: number;
}

/** Ordena por posición y descarta puntuaciones no válidas. */
function sortedValidMeasurements(measurements: readonly FocusMeasurement[]): FocusMeasurement[] {
  return measurements
    .filter((measurement) => Number.isFinite(measurement.focusPosition) && Number.isFinite(measurement.score) && measurement.score > 0)
    .sort((first, second) => first.focusPosition - second.focusPosition);
}

/** Vértice de la parábola por tres puntos, o `null` si no es un máximo. */
function parabolaVertex(
  firstX: number,
  firstY: number,
  middleX: number,
  middleY: number,
  lastX: number,
  lastY: number,
): number | null {
  const denominator = (firstX - middleX) * (firstX - lastX) * (middleX - lastX);
  if (denominator === 0) return null;
  const quadraticCoefficient = (lastX * (middleY - firstY) + middleX * (firstY - lastY) + firstX * (lastY - middleY)) / denominator;
  const linearCoefficient =
    (lastX * lastX * (firstY - middleY) + middleX * middleX * (lastY - firstY) + firstX * firstX * (middleY - lastY)) / denominator;
  if (quadraticCoefficient >= 0) return null;
  return -linearCoefficient / (2 * quadraticCoefficient);
}

/** Mejor enfoque de una serie, o `null` si no hay ninguna medida válida. */
export function estimateBestFocus(measurements: readonly FocusMeasurement[]): BestFocusEstimate | null {
  const sortedMeasurements = sortedValidMeasurements(measurements);
  if (sortedMeasurements.length === 0) return null;
  let bestMeasuredIndex = 0;
  sortedMeasurements.forEach((measurement, measurementIndex) => {
    if (measurement.score > sortedMeasurements[bestMeasuredIndex]!.score) bestMeasuredIndex = measurementIndex;
  });
  const bestMeasurement = sortedMeasurements[bestMeasuredIndex]!;
  const lowerNeighbor = sortedMeasurements[bestMeasuredIndex - 1];
  const upperNeighbor = sortedMeasurements[bestMeasuredIndex + 1];
  const isBracketed = lowerNeighbor !== undefined && upperNeighbor !== undefined;
  let estimatedBestPosition = bestMeasurement.focusPosition;
  if (lowerNeighbor && upperNeighbor) {
    const vertexPosition = parabolaVertex(
      lowerNeighbor.focusPosition,
      Math.log(lowerNeighbor.score),
      bestMeasurement.focusPosition,
      Math.log(bestMeasurement.score),
      upperNeighbor.focusPosition,
      Math.log(upperNeighbor.score),
    );
    if (vertexPosition !== null) {
      estimatedBestPosition = Math.min(upperNeighbor.focusPosition, Math.max(lowerNeighbor.focusPosition, vertexPosition));
    }
  }
  return {
    bestMeasuredIndex,
    bestMeasuredPosition: bestMeasurement.focusPosition,
    estimatedBestPosition,
    isBracketed,
    bracketLowPosition: (lowerNeighbor ?? bestMeasurement).focusPosition,
    bracketHighPosition: (upperNeighbor ?? bestMeasurement).focusPosition,
  };
}

export interface FocusSeriesOptions {
  /** Fotos por serie. */
  stepCount: number;
  /** Paso por debajo del cual se da por encontrado el enfoque (resolución útil del enfoque). */
  minimumStepSize: number;
  minimumPosition: number;
  maximumPosition: number;
}

export interface FocusSeriesProposal {
  /** Posiciones de la serie siguiente (vacía si ya ha convergido). */
  nextPositions: number[];
  hasConverged: boolean;
  estimatedBestPosition: number;
}

/** Serie de `stepCount` posiciones repartidas en [inicio, fin], recortadas al rango. */
function evenlySpacedPositions(startPosition: number, endPosition: number, options: FocusSeriesOptions): number[] {
  const clampedStart = Math.max(options.minimumPosition, Math.min(options.maximumPosition, startPosition));
  const clampedEnd = Math.max(options.minimumPosition, Math.min(options.maximumPosition, endPosition));
  if (options.stepCount <= 1) return [(clampedStart + clampedEnd) / 2];
  return Array.from(
    { length: options.stepCount },
    (_unused, stepIndex) => clampedStart + ((clampedEnd - clampedStart) * stepIndex) / (options.stepCount - 1),
  );
}

/** Serie inicial: todo el rango de enfoque. */
export function initialFocusSeries(options: FocusSeriesOptions): number[] {
  return evenlySpacedPositions(options.minimumPosition, options.maximumPosition, options);
}

/** Propuesta de la serie siguiente a partir de TODAS las medidas hechas hasta ahora. */
export function proposeNextFocusSeries(measurements: readonly FocusMeasurement[], options: FocusSeriesOptions): FocusSeriesProposal {
  const bestFocus = estimateBestFocus(measurements);
  if (!bestFocus) return { nextPositions: initialFocusSeries(options), hasConverged: false, estimatedBestPosition: Number.NaN };
  const sortedPositions = sortedValidMeasurements(measurements).map((measurement) => measurement.focusPosition);

  if (!bestFocus.isBracketed) {
    // La mejor está en un extremo: seguir en esa dirección con el paso local (salvo que ya sea el
    // límite del rango, y entonces el óptimo es ese límite).
    const isAtLowerEnd = bestFocus.bestMeasuredIndex === 0;
    const neighborPosition = sortedPositions[isAtLowerEnd ? 1 : sortedPositions.length - 2];
    const localStep = neighborPosition === undefined ? options.minimumStepSize : Math.abs(neighborPosition - bestFocus.bestMeasuredPosition);
    const rangeLimit = isAtLowerEnd ? options.minimumPosition : options.maximumPosition;
    if (Math.abs(bestFocus.bestMeasuredPosition - rangeLimit) < options.minimumStepSize / 2 || localStep < options.minimumStepSize) {
      return { nextPositions: [], hasConverged: true, estimatedBestPosition: bestFocus.bestMeasuredPosition };
    }
    const direction = isAtLowerEnd ? -1 : 1;
    const seriesSpan = localStep * Math.max(1, options.stepCount - 1);
    const nextPositions = evenlySpacedPositions(
      bestFocus.bestMeasuredPosition,
      bestFocus.bestMeasuredPosition + direction * seriesSpan,
      options,
    ).filter((position) => Math.abs(position - bestFocus.bestMeasuredPosition) > 1e-12);
    return { nextPositions, hasConverged: false, estimatedBestPosition: bestFocus.bestMeasuredPosition };
  }

  const bracketWidth = bestFocus.bracketHighPosition - bestFocus.bracketLowPosition;
  const nextSpan = bracketWidth / 2;
  const nextStep = nextSpan / Math.max(1, options.stepCount - 1);
  if (nextStep < options.minimumStepSize) {
    return { nextPositions: [], hasConverged: true, estimatedBestPosition: bestFocus.estimatedBestPosition };
  }
  return {
    nextPositions: evenlySpacedPositions(
      bestFocus.estimatedBestPosition - nextSpan / 2,
      bestFocus.estimatedBestPosition + nextSpan / 2,
      options,
    ),
    hasConverged: false,
    estimatedBestPosition: bestFocus.estimatedBestPosition,
  };
}
