/**
 * Plan del barrido de enfoque del «macro enfocado»: qué posiciones del objetivo
 * (`setFocusLocked`, 0 = lo más cerca, 1 = infinito) se fotografían.
 *
 * Con el sondeo automático, antes del barrido se toman unas pocas fotos pequeñas en posiciones
 * repartidas por todo el recorrido y se puntúa la nitidez de cada casilla de una rejilla
 * (Tenengrad normalizado, como `sceneFocusScore`). Cada casilla con textura tiene su posición
 * de mejor enfoque; el barrido va de la más cercana a la más lejana, con un margen a cada lado
 * («desde cerca hasta un poco más allá del objeto»). Las casillas lisas (sin diferencia entre
 * fotos) no cuentan.
 *
 * El paso entre fotos: en Android la posición es lineal en dioptrías; con un objetivo que enfoca
 * a 10 cm, todo el recorrido son ~10 dioptrías y la profundidad de campo de un móvil a esas
 * distancias es de ~0,3 dioptrías: un paso de 0,03-0,04 deja las zonas nítidas solapadas.
 *
 * Módulo puro: sin React ni React Native.
 */

import { estimateBestFocus } from './focusBracketing';
import { gaussianBlurGray, grayImageFromRgb } from './grayImage';

/** Posiciones del sondeo previo (más densas cerca, donde la profundidad de campo es menor en distancia). */
export const focusProbePositions: readonly number[] = [0, 0.1, 0.2, 0.32, 0.45, 0.6, 0.78, 1];

export interface FocusProbeMeasurement {
  lensPosition: number;
  /** Puntuación de cada casilla de la rejilla (fila a fila). */
  tileScores: number[];
}

export interface FocusSweepPlanningOptions {
  /** Margen a cada lado del rango encontrado. */
  marginPosition: number;
  /** Paso deseado entre fotos. */
  preferredStepPosition: number;
  minimumFrameCount: number;
  maximumFrameCount: number;
  /** Una casilla cuenta si su mejor puntuación supera a la peor en este factor. */
  minimumContrastRatio: number;
  /** Rango si ninguna casilla tiene textura suficiente. */
  fallbackRange: FocusRange;
}

export interface FocusRange {
  nearPosition: number;
  farPosition: number;
}

export const defaultFocusSweepPlanningOptions: FocusSweepPlanningOptions = {
  marginPosition: 0.04,
  preferredStepPosition: 0.035,
  minimumFrameCount: 5,
  maximumFrameCount: 15,
  minimumContrastRatio: 1.6,
  fallbackRange: { nearPosition: 0, farPosition: 0.5 },
};

export interface FocusSweepPlan extends FocusRange {
  /** Posiciones del barrido, de cerca a lejos. */
  positions: number[];
  /** Separación real entre fotos. */
  stepPosition: number;
  /** El paso es bastante mayor que el deseado: entre fotos puede quedar algo sin enfocar. */
  hasFocusGaps: boolean;
  /** Casillas con textura que han decidido el rango (0 si se usó el de reserva). */
  usedTileCount: number;
  isFallback: boolean;
}

/** Tenengrad normalizado por casilla (`tilesPerSide`², fila a fila) de una foto RGB. */
export function measureTileFocusScores(rgbPixels: Uint8Array, width: number, height: number, tilesPerSide: number): number[] {
  const { values } = gaussianBlurGray(grayImageFromRgb(rgbPixels, width, height), 0.7);
  const tileScores: number[] = [];
  for (let tileRow = 0; tileRow < tilesPerSide; tileRow++) {
    const firstRow = Math.max(1, Math.floor((tileRow * height) / tilesPerSide));
    const endRow = Math.min(height - 1, Math.floor(((tileRow + 1) * height) / tilesPerSide));
    for (let tileColumn = 0; tileColumn < tilesPerSide; tileColumn++) {
      const firstColumn = Math.max(1, Math.floor((tileColumn * width) / tilesPerSide));
      const endColumn = Math.min(width - 1, Math.floor(((tileColumn + 1) * width) / tilesPerSide));
      let squaredGradientSum = 0;
      let brightnessSum = 0;
      let sampleCount = 0;
      for (let rowIndex = firstRow; rowIndex < endRow; rowIndex++) {
        for (let columnIndex = firstColumn; columnIndex < endColumn; columnIndex++) {
          const pixelIndex = rowIndex * width + columnIndex;
          const aboveIndex = pixelIndex - width;
          const belowIndex = pixelIndex + width;
          const sobelX =
            values[aboveIndex + 1]! + 2 * values[pixelIndex + 1]! + values[belowIndex + 1]! -
            values[aboveIndex - 1]! - 2 * values[pixelIndex - 1]! - values[belowIndex - 1]!;
          const sobelY =
            values[belowIndex - 1]! + 2 * values[belowIndex]! + values[belowIndex + 1]! -
            values[aboveIndex - 1]! - 2 * values[aboveIndex]! - values[aboveIndex + 1]!;
          squaredGradientSum += sobelX * sobelX + sobelY * sobelY;
          brightnessSum += values[pixelIndex]!;
          sampleCount++;
        }
      }
      const meanBrightness = sampleCount > 0 ? brightnessSum / sampleCount : 0;
      tileScores.push(meanBrightness > 0 ? squaredGradientSum / sampleCount / (meanBrightness * meanBrightness) : 0);
    }
  }
  return tileScores;
}

/** `frameCount` posiciones repartidas por igual de `nearPosition` a `farPosition`. */
export function evenlySpacedFocusPositions(nearPosition: number, farPosition: number, frameCount: number): number[] {
  if (frameCount <= 1) return [(nearPosition + farPosition) / 2];
  return Array.from({ length: frameCount }, (_unused, frameIndex) => nearPosition + ((farPosition - nearPosition) * frameIndex) / (frameCount - 1));
}

/** Plan para un rango dado: tantas fotos como pida el paso deseado, dentro de los límites. */
export function planFocusSweepForRange(
  range: FocusRange,
  options: FocusSweepPlanningOptions = defaultFocusSweepPlanningOptions,
): Omit<FocusSweepPlan, 'usedTileCount' | 'isFallback'> {
  const nearPosition = Math.max(0, Math.min(1, Math.min(range.nearPosition, range.farPosition)));
  const farPosition = Math.max(0, Math.min(1, Math.max(range.nearPosition, range.farPosition)));
  const span = farPosition - nearPosition;
  const frameCount = Math.min(
    options.maximumFrameCount,
    Math.max(options.minimumFrameCount, Math.ceil(span / options.preferredStepPosition) + 1),
  );
  const stepPosition = frameCount > 1 ? span / (frameCount - 1) : 0;
  return {
    nearPosition,
    farPosition,
    positions: evenlySpacedFocusPositions(nearPosition, farPosition, frameCount),
    stepPosition,
    hasFocusGaps: stepPosition > 1.5 * options.preferredStepPosition,
  };
}

/** Plan a partir del sondeo: del mejor enfoque de la casilla más cercana al de la más lejana. */
export function planFocusSweepFromProbe(
  measurements: readonly FocusProbeMeasurement[],
  options: FocusSweepPlanningOptions = defaultFocusSweepPlanningOptions,
): FocusSweepPlan {
  const tileCount = Math.min(...measurements.map((measurement) => measurement.tileScores.length));
  const bestTilePositions: number[] = [];
  if (measurements.length >= 3 && Number.isFinite(tileCount)) {
    for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
      const tileMeasurements = measurements.map((measurement) => ({
        focusPosition: measurement.lensPosition,
        score: measurement.tileScores[tileIndex]!,
      }));
      const tileScores = tileMeasurements.map((tileMeasurement) => tileMeasurement.score);
      const highestScore = Math.max(...tileScores);
      const lowestScore = Math.min(...tileScores);
      if (!(highestScore > 0) || highestScore < options.minimumContrastRatio * Math.max(lowestScore, 1e-12)) continue;
      const bestFocus = estimateBestFocus(tileMeasurements);
      if (bestFocus) bestTilePositions.push(bestFocus.estimatedBestPosition);
    }
  }
  if (bestTilePositions.length === 0) {
    return { ...planFocusSweepForRange(options.fallbackRange, options), usedTileCount: 0, isFallback: true };
  }
  const nearestBest = Math.min(...bestTilePositions);
  const farthestBest = Math.max(...bestTilePositions);
  return {
    ...planFocusSweepForRange(
      { nearPosition: nearestBest - options.marginPosition, farPosition: farthestBest + options.marginPosition },
      options,
    ),
    usedTileCount: bestTilePositions.length,
    isFallback: false,
  };
}

/**
 * Distancia aproximada (cm) de una posición, suponiendo que la escala es lineal en dioptrías y
 * que 0 corresponde a `minimumFocusDistanceCentimeters`. Infinito en la posición 1.
 */
export function approximateFocusDistanceCentimeters(lensPosition: number, minimumFocusDistanceCentimeters = 10): number {
  const diopters = (100 / minimumFocusDistanceCentimeters) * (1 - lensPosition);
  return diopters > 1e-6 ? 100 / diopters : Number.POSITIVE_INFINITY;
}
