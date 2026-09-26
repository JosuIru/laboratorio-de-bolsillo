/**
 * Apilado de enfoque («focus stacking»): varias fotos del mismo objeto cercano, cada una enfocada
 * a una distancia, se combinan en una sola nítida de delante a atrás.
 *
 * 1. Alineado. Las fotos vienen ordenadas de enfoque cercano a lejano. Se alinea cada una con su
 *    vecina hacia la del medio (entre vecinas el desenfoque cambia poco y el alineado es fiable)
 *    y se encadenan las transformaciones: escala (el «focus breathing» del objetivo), giro leve y
 *    traslación (`similarityAlignment`). Todas quedan en la geometría de la foto del medio.
 * 2. Nitidez local. Por foto, la energía del laplaciano (su cuadrado) de la luminancia, suavizada
 *    en unos pocos píxeles: alta donde esa foto está enfocada. Se calcula en la foto original
 *    (antes de remuestrear, que emborronaría distinto cada foto) y luego se lleva a la geometría
 *    común. Por píxel se elige la foto con más energía: el «mapa de qué foto se usó», que es un
 *    mapa de profundidad aproximado (foto 0 = lo más cercano).
 * 3. Fusión con pirámide laplaciana (Burt y Adelson): cada foto se descompone en bandas de
 *    detalle; cada banda se mezcla con los pesos (la elección por píxel) suavizados a esa escala.
 *    El detalle fino cambia de foto en poco espacio y el tono general en mucho: sin costuras ni
 *    los halos de una mezcla directa. Solo la luminancia va por la pirámide; el color (diferencias
 *    azul − Y y rojo − Y, que no tiene detalle fino) se mezcla directamente con los pesos.
 *
 * Todas las fotos cuadradas (`size`²) y RGB de 8 bits. Módulo puro: sin React ni React Native.
 */

import { approximateGaussianBlurPlane, smoothWithBinomial3 } from './fastPlaneBlur';
import { grayImageFromRgb, percentileOfValues } from './grayImage';
import type { FloatRgbImage } from './lunarStacking';
import {
  composeSimilarity,
  createSimilarityAligner,
  identitySimilarity,
  type SimilarityTransform,
  similarityScale,
  warpPlaneWithSimilarity,
  warpPlaneWithSimilarityBicubic,
} from './similarityAlignment';

export interface FocusStackOptions {
  /** Mayor traslación entre dos fotos vecinas que se busca (px). */
  maximumShiftPixels: number;
  estimateRotation: boolean;
  /** Suavizado del mapa de energía; por defecto, según el tamaño (`defaultEnergySmoothingSigma`). */
  energySmoothingSigmaPixels?: number;
}

export const defaultFocusStackOptions: FocusStackOptions = {
  maximumShiftPixels: 48,
  estimateRotation: true,
};

/**
 * Suavizado de la energía: bastante más ancho que el desenfoque que se quiere distinguir (unos
 * pocos píxeles), para que la elección no salte de foto en foto con el ruido.
 */
export function defaultEnergySmoothingSigma(size: number): number {
  return Math.max(2, size / 160);
}

export interface FocusStackTimings {
  alignmentMilliseconds: number;
  sharpnessMilliseconds: number;
  blendMilliseconds: number;
  totalMilliseconds: number;
}

export interface FocusStackResult {
  stackedImage: FloatRgbImage;
  /** La foto con más nitidez en total, alineada como el resultado, para comparar. */
  bestSingleImage: FloatRgbImage;
  bestSingleFrameIndex: number;
  /** Foto del medio: la geometría común. */
  referenceFrameIndex: number;
  /** De la referencia a cada foto. */
  transforms: SimilarityTransform[];
  /** Por píxel, índice de la foto más nítida. */
  sourceIndexMap: Uint8Array;
  /** Por píxel, 0-1: cuánto destaca la foto elegida sobre las demás (0 en zonas lisas). */
  confidenceMap: Float32Array;
  /** Fracción de píxeles que sale de cada foto. */
  frameUsageFractions: number[];
  /** Mayor |escala − 1| entre la referencia y una foto, en %. */
  focusBreathingPercent: number;
  /** Mayor traslación respecto a la referencia (px). */
  maximumShiftPixels: number;
  timings: FocusStackTimings;
}

// ---------------------------------------------------------------------------------------------
// Energía del laplaciano
// ---------------------------------------------------------------------------------------------

/** Energía local del laplaciano de la luminancia (suavizada), en la geometría de la propia foto. */
export function laplacianEnergyMap(luminance: Float32Array, size: number, smoothingSigmaPixels: number): Float32Array {
  const smoothedLuminance = smoothWithBinomial3(luminance, size, size);
  const squaredLaplacian = new Float32Array(size * size);
  for (let rowIndex = 1; rowIndex < size - 1; rowIndex++) {
    for (let columnIndex = 1; columnIndex < size - 1; columnIndex++) {
      const pixelIndex = rowIndex * size + columnIndex;
      const laplacian =
        4 * smoothedLuminance[pixelIndex]! -
        smoothedLuminance[pixelIndex - 1]! -
        smoothedLuminance[pixelIndex + 1]! -
        smoothedLuminance[pixelIndex - size]! -
        smoothedLuminance[pixelIndex + size]!;
      squaredLaplacian[pixelIndex] = laplacian * laplacian;
    }
  }
  return approximateGaussianBlurPlane(squaredLaplacian, size, size, smoothingSigmaPixels);
}

// ---------------------------------------------------------------------------------------------
// Pirámide laplaciana (tamaños cualesquiera)
// ---------------------------------------------------------------------------------------------

interface PlaneLevel {
  width: number;
  height: number;
  values: Float32Array;
}

const binomialOuterWeight = 1 / 16;
const binomialInnerWeight = 4 / 16;
const binomialCentreWeight = 6 / 16;

/** Mitad de resolución (lado redondeado hacia arriba) con el núcleo 1-4-6-4-1: solo se calculan las muestras que se quedan. */
function downsamplePlane(level: PlaneLevel): PlaneLevel {
  const { width, height, values } = level;
  const halfWidth = Math.ceil(width / 2);
  const halfHeight = Math.ceil(height / 2);
  const lastColumn = width - 1;
  const lastRow = height - 1;
  const horizontallySmoothed = new Float32Array(height * halfWidth);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const rowStart = rowIndex * width;
    for (let halfColumn = 0; halfColumn < halfWidth; halfColumn++) {
      const centreColumn = 2 * halfColumn;
      const outerLeft = centreColumn - 2 < 0 ? 0 : centreColumn - 2;
      const innerLeft = centreColumn - 1 < 0 ? 0 : centreColumn - 1;
      const innerRight = centreColumn + 1 > lastColumn ? lastColumn : centreColumn + 1;
      const outerRight = centreColumn + 2 > lastColumn ? lastColumn : centreColumn + 2;
      horizontallySmoothed[rowIndex * halfWidth + halfColumn] =
        binomialOuterWeight * (values[rowStart + outerLeft]! + values[rowStart + outerRight]!) +
        binomialInnerWeight * (values[rowStart + innerLeft]! + values[rowStart + innerRight]!) +
        binomialCentreWeight * values[rowStart + centreColumn]!;
    }
  }
  const halfValues = new Float32Array(halfWidth * halfHeight);
  for (let halfRow = 0; halfRow < halfHeight; halfRow++) {
    const centreRow = 2 * halfRow;
    const outerAboveStart = (centreRow - 2 < 0 ? 0 : centreRow - 2) * halfWidth;
    const innerAboveStart = (centreRow - 1 < 0 ? 0 : centreRow - 1) * halfWidth;
    const centreStart = centreRow * halfWidth;
    const innerBelowStart = (centreRow + 1 > lastRow ? lastRow : centreRow + 1) * halfWidth;
    const outerBelowStart = (centreRow + 2 > lastRow ? lastRow : centreRow + 2) * halfWidth;
    for (let halfColumn = 0; halfColumn < halfWidth; halfColumn++) {
      halfValues[halfRow * halfWidth + halfColumn] =
        binomialOuterWeight * (horizontallySmoothed[outerAboveStart + halfColumn]! + horizontallySmoothed[outerBelowStart + halfColumn]!) +
        binomialInnerWeight * (horizontallySmoothed[innerAboveStart + halfColumn]! + horizontallySmoothed[innerBelowStart + halfColumn]!) +
        binomialCentreWeight * horizontallySmoothed[centreStart + halfColumn]!;
    }
  }
  return { width: halfWidth, height: halfHeight, values: halfValues };
}

/** Amplía un nivel al tamaño del anterior (bilineal: el píxel grueso i está en el fino 2i). */
function upsamplePlane(level: PlaneLevel, targetWidth: number, targetHeight: number): Float32Array {
  const { width, height, values } = level;
  const upsampledValues = new Float32Array(targetWidth * targetHeight);
  const columnIndices = new Int32Array(targetWidth);
  const columnWeights = new Float32Array(targetWidth);
  for (let columnIndex = 0; columnIndex < targetWidth; columnIndex++) {
    const coarseX = Math.min(width - 1, columnIndex / 2);
    const leftColumn = Math.min(Math.max(0, width - 2), Math.floor(coarseX));
    columnIndices[columnIndex] = leftColumn;
    columnWeights[columnIndex] = width > 1 ? coarseX - leftColumn : 0;
  }
  const hasSecondColumn = width > 1 ? 1 : 0;
  for (let rowIndex = 0; rowIndex < targetHeight; rowIndex++) {
    const coarseY = Math.min(height - 1, rowIndex / 2);
    const topRow = Math.min(Math.max(0, height - 2), Math.floor(coarseY));
    const verticalWeight = height > 1 ? coarseY - topRow : 0;
    const topStart = topRow * width;
    const bottomStart = height > 1 ? topStart + width : topStart;
    for (let columnIndex = 0; columnIndex < targetWidth; columnIndex++) {
      const leftColumn = columnIndices[columnIndex]!;
      const horizontalWeight = columnWeights[columnIndex]!;
      const topValue = values[topStart + leftColumn]! + horizontalWeight * (values[topStart + leftColumn + hasSecondColumn]! - values[topStart + leftColumn]!);
      const bottomValue =
        values[bottomStart + leftColumn]! + horizontalWeight * (values[bottomStart + leftColumn + hasSecondColumn]! - values[bottomStart + leftColumn]!);
      upsampledValues[rowIndex * targetWidth + columnIndex] = topValue + verticalWeight * (bottomValue - topValue);
    }
  }
  return upsampledValues;
}

function gaussianPyramid(base: PlaneLevel, levelCount: number): PlaneLevel[] {
  const levels = [base];
  for (let levelIndex = 1; levelIndex < levelCount; levelIndex++) levels.push(downsamplePlane(levels[levelIndex - 1]!));
  return levels;
}

/** Bandas de detalle: nivel − ampliación del siguiente; el último nivel es el propio gaussiano. */
function laplacianPyramid(base: PlaneLevel, levelCount: number): PlaneLevel[] {
  const gaussianLevels = gaussianPyramid(base, levelCount);
  return gaussianLevels.map((gaussianLevel, levelIndex) => {
    const coarserLevel = gaussianLevels[levelIndex + 1];
    if (!coarserLevel) return gaussianLevel;
    const upsampledCoarser = upsamplePlane(coarserLevel, gaussianLevel.width, gaussianLevel.height);
    const detailValues = new Float32Array(gaussianLevel.values.length);
    for (let valueIndex = 0; valueIndex < detailValues.length; valueIndex++) {
      detailValues[valueIndex] = gaussianLevel.values[valueIndex]! - upsampledCoarser[valueIndex]!;
    }
    return { width: gaussianLevel.width, height: gaussianLevel.height, values: detailValues };
  });
}

/** Niveles de la pirámide: hasta que el lado baja de ~8-16 px, como mucho 6. */
export function pyramidLevelCount(size: number): number {
  return Math.max(1, Math.min(6, Math.floor(Math.log2(size / 8))));
}

// ---------------------------------------------------------------------------------------------
// Proceso completo
// ---------------------------------------------------------------------------------------------

/** Suavizado de la elección por píxel antes de la pirámide (px). */
const selectionSmoothingSigmaPixels = 1;
/** Zona central (fracción del lado) donde se compara la nitidez total de cada foto. */
const centralRegionFraction = 0.6;

interface LuminanceChromaPlanes {
  luminance: Float32Array;
  blueDifference: Float32Array;
  redDifference: Float32Array;
}

function splitLuminanceAndChroma(channels: Uint8Array, pixelCount: number): LuminanceChromaPlanes {
  const luminance = new Float32Array(pixelCount);
  const blueDifference = new Float32Array(pixelCount);
  const redDifference = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const red = channels[pixelIndex * 3]!;
    const green = channels[pixelIndex * 3 + 1]!;
    const blue = channels[pixelIndex * 3 + 2]!;
    const luminanceValue = 0.299 * red + 0.587 * green + 0.114 * blue;
    luminance[pixelIndex] = luminanceValue;
    blueDifference[pixelIndex] = blue - luminanceValue;
    redDifference[pixelIndex] = red - luminanceValue;
  }
  return { luminance, blueDifference, redDifference };
}

function joinLuminanceAndChroma(size: number, { luminance, blueDifference, redDifference }: LuminanceChromaPlanes): FloatRgbImage {
  const channels = new Float32Array(size * size * 3);
  for (let pixelIndex = 0; pixelIndex < size * size; pixelIndex++) {
    const luminanceValue = luminance[pixelIndex]!;
    const red = luminanceValue + redDifference[pixelIndex]!;
    const blue = luminanceValue + blueDifference[pixelIndex]!;
    channels[pixelIndex * 3] = red;
    channels[pixelIndex * 3 + 1] = (luminanceValue - 0.299 * red - 0.114 * blue) / 0.587;
    channels[pixelIndex * 3 + 2] = blue;
  }
  return { size, channels };
}

/**
 * Lleva una foto a la geometría común: la luminancia con interpolación bicúbica (conserva el
 * detalle fino) y el color, que no lo tiene, con la bilineal. null = la referencia (no se mueve).
 */
function warpLuminanceAndChroma(rgbPixels: Uint8Array, size: number, transform: SimilarityTransform | null): LuminanceChromaPlanes {
  const planes = splitLuminanceAndChroma(rgbPixels, size * size);
  if (!transform) return planes;
  return {
    luminance: warpPlaneWithSimilarityBicubic(planes.luminance, size, size, transform),
    blueDifference: warpPlaneWithSimilarity(planes.blueDifference, size, size, transform, null),
    redDifference: warpPlaneWithSimilarity(planes.redDifference, size, size, transform, null),
  };
}

/**
 * Apila una serie de fotos ordenada de enfoque cercano a lejano. Con una sola foto, el resultado
 * es ella misma.
 */
export function stackFocusBracket(
  frames: readonly Uint8Array[],
  size: number,
  options: FocusStackOptions = defaultFocusStackOptions,
  now: () => number = Date.now,
): FocusStackResult {
  if (frames.length === 0) throw new Error('No hay fotos para apilar');
  if (frames.length > 255) throw new Error('Demasiadas fotos para apilar');
  const startTime = now();
  const frameCount = frames.length;
  const pixelCount = size * size;
  const referenceFrameIndex = Math.floor((frameCount - 1) / 2);
  const energySmoothingSigma = options.energySmoothingSigmaPixels ?? defaultEnergySmoothingSigma(size);
  const alignmentOptions = { maximumShiftPixels: options.maximumShiftPixels, estimateRotation: options.estimateRotation };

  // 1-2. Alineado encadenado desde la del medio y energía de cada foto en la geometría común.
  const transforms: SimilarityTransform[] = new Array<SimilarityTransform>(frameCount).fill(identitySimilarity);
  const bestEnergy = new Float32Array(pixelCount).fill(-1);
  const sourceIndexMap = new Uint8Array(pixelCount);
  const energySum = new Float32Array(pixelCount);
  const validFrameCount = new Uint8Array(pixelCount);
  const frameTotalEnergies = new Array<number>(frameCount).fill(0);
  const centralStart = Math.floor((size * (1 - centralRegionFraction)) / 2);
  const centralEnd = size - centralStart;
  let alignmentMilliseconds = 0;
  let sharpnessMilliseconds = 0;

  function accumulateEnergy(frameIndex: number, luminance: Float32Array) {
    const sharpnessStartTime = now();
    const ownEnergy = laplacianEnergyMap(luminance, size, energySmoothingSigma);
    const transform = transforms[frameIndex]!;
    const warpedEnergy = frameIndex === referenceFrameIndex ? ownEnergy : warpPlaneWithSimilarity(ownEnergy, size, size, transform, -1);
    let centralEnergySum = 0;
    for (let rowIndex = centralStart; rowIndex < centralEnd; rowIndex++) {
      for (let columnIndex = centralStart; columnIndex < centralEnd; columnIndex++) {
        centralEnergySum += Math.max(0, warpedEnergy[rowIndex * size + columnIndex]!);
      }
    }
    frameTotalEnergies[frameIndex] = centralEnergySum;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const energy = warpedEnergy[pixelIndex]!;
      if (energy < 0) continue;
      energySum[pixelIndex] = energySum[pixelIndex]! + energy;
      validFrameCount[pixelIndex] = validFrameCount[pixelIndex]! + 1;
      if (energy > bestEnergy[pixelIndex]!) {
        bestEnergy[pixelIndex] = energy;
        sourceIndexMap[pixelIndex] = frameIndex;
      }
    }
    sharpnessMilliseconds += now() - sharpnessStartTime;
  }

  const referenceLuminance = grayImageFromRgb(frames[referenceFrameIndex]!, size, size);
  accumulateEnergy(referenceFrameIndex, referenceLuminance.values);
  for (const direction of [1, -1]) {
    let previousLuminance = referenceLuminance;
    let previousTransform = identitySimilarity;
    for (let frameIndex = referenceFrameIndex + direction; frameIndex >= 0 && frameIndex < frameCount; frameIndex += direction) {
      const alignmentStartTime = now();
      const frameLuminance = grayImageFromRgb(frames[frameIndex]!, size, size);
      // De la vecina (más cerca del medio) a esta foto, y encadenado desde la referencia.
      const neighbourToFrame = createSimilarityAligner(previousLuminance, alignmentOptions)(frameLuminance).transform;
      const referenceToFrame = composeSimilarity(previousTransform, neighbourToFrame);
      transforms[frameIndex] = referenceToFrame;
      alignmentMilliseconds += now() - alignmentStartTime;
      accumulateEnergy(frameIndex, frameLuminance.values);
      previousLuminance = frameLuminance;
      previousTransform = referenceToFrame;
    }
  }

  // Confianza: cuánto sobresale la mejor energía sobre la media de las fotos en ese punto.
  const sharpnessStartTime = now();
  const energyFloor = 0.02 * percentileOfValues(bestEnergy, 99) + 1e-6;
  const confidenceMap = new Float32Array(pixelCount);
  const usageCounts = new Array<number>(frameCount).fill(0);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const best = bestEnergy[pixelIndex]!;
    const meanEnergy = energySum[pixelIndex]! / Math.max(1, validFrameCount[pixelIndex]!);
    const confidence = (1.5 * (best - meanEnergy)) / (best + energyFloor);
    confidenceMap[pixelIndex] = confidence < 0 ? 0 : confidence > 1 ? 1 : confidence;
    usageCounts[sourceIndexMap[pixelIndex]!] = usageCounts[sourceIndexMap[pixelIndex]!]! + 1;
  }
  let bestSingleFrameIndex = referenceFrameIndex;
  frameTotalEnergies.forEach((totalEnergy, frameIndex) => {
    if (totalEnergy > frameTotalEnergies[bestSingleFrameIndex]!) bestSingleFrameIndex = frameIndex;
  });
  sharpnessMilliseconds += now() - sharpnessStartTime;

  // 3. Fusión: luminancia por pirámide laplaciana, color con los pesos directos.
  const blendStartTime = now();
  const levelCount = pyramidLevelCount(size);
  let blendedLevels: PlaneLevel[] | null = null;
  let weightSumLevels: Float32Array[] | null = null;
  const blueDifferenceSum = new Float32Array(pixelCount);
  const redDifferenceSum = new Float32Array(pixelCount);
  const chromaWeightSum = new Float32Array(pixelCount);
  let bestSingleImage: FloatRgbImage | null = null;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const isBestSingle = frameIndex === bestSingleFrameIndex;
    if (usageCounts[frameIndex] === 0 && !isBestSingle) continue;
    const warpedPlanes = warpLuminanceAndChroma(frames[frameIndex]!, size, frameIndex === referenceFrameIndex ? null : transforms[frameIndex]!);
    if (isBestSingle) bestSingleImage = joinLuminanceAndChroma(size, warpedPlanes);
    if (usageCounts[frameIndex] === 0) continue;
    const selectionMask = new Float32Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      if (sourceIndexMap[pixelIndex] === frameIndex) selectionMask[pixelIndex] = 1;
    }
    const weights = approximateGaussianBlurPlane(selectionMask, size, size, selectionSmoothingSigmaPixels);
    const { luminance, blueDifference, redDifference } = warpedPlanes;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const weight = weights[pixelIndex]!;
      blueDifferenceSum[pixelIndex] = blueDifferenceSum[pixelIndex]! + weight * blueDifference[pixelIndex]!;
      redDifferenceSum[pixelIndex] = redDifferenceSum[pixelIndex]! + weight * redDifference[pixelIndex]!;
      chromaWeightSum[pixelIndex] = chromaWeightSum[pixelIndex]! + weight;
    }
    const detailLevels = laplacianPyramid({ width: size, height: size, values: luminance }, levelCount);
    const weightLevels = gaussianPyramid({ width: size, height: size, values: weights }, levelCount);
    blendedLevels ??= detailLevels.map((detailLevel) => ({ ...detailLevel, values: new Float32Array(detailLevel.values.length) }));
    weightSumLevels ??= detailLevels.map((detailLevel) => new Float32Array(detailLevel.values.length));
    for (let levelIndex = 0; levelIndex < levelCount; levelIndex++) {
      const detailValues = detailLevels[levelIndex]!.values;
      const weightValues = weightLevels[levelIndex]!.values;
      const blendedValues = blendedLevels[levelIndex]!.values;
      const weightSums = weightSumLevels[levelIndex]!;
      for (let valueIndex = 0; valueIndex < detailValues.length; valueIndex++) {
        const weight = weightValues[valueIndex]!;
        blendedValues[valueIndex] = blendedValues[valueIndex]! + weight * detailValues[valueIndex]!;
        weightSums[valueIndex] = weightSums[valueIndex]! + weight;
      }
    }
  }
  if (!blendedLevels || !weightSumLevels || !bestSingleImage) throw new Error('No se ha podido fusionar ninguna foto');
  for (let levelIndex = 0; levelIndex < levelCount; levelIndex++) {
    const blendedValues = blendedLevels[levelIndex]!.values;
    const weightSums = weightSumLevels[levelIndex]!;
    for (let valueIndex = 0; valueIndex < blendedValues.length; valueIndex++) {
      const weightSum = weightSums[valueIndex]!;
      blendedValues[valueIndex] = weightSum > 1e-6 ? blendedValues[valueIndex]! / weightSum : 0;
    }
  }
  // Se reconstruye de lo grueso a lo fino.
  let collapsedLevel = blendedLevels[levelCount - 1]!;
  for (let levelIndex = levelCount - 2; levelIndex >= 0; levelIndex--) {
    const detailLevel = blendedLevels[levelIndex]!;
    const upsampledCoarser = upsamplePlane(collapsedLevel, detailLevel.width, detailLevel.height);
    const reconstructedValues = new Float32Array(detailLevel.values.length);
    for (let valueIndex = 0; valueIndex < reconstructedValues.length; valueIndex++) {
      reconstructedValues[valueIndex] = detailLevel.values[valueIndex]! + upsampledCoarser[valueIndex]!;
    }
    collapsedLevel = { width: detailLevel.width, height: detailLevel.height, values: reconstructedValues };
  }
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const weightSum = chromaWeightSum[pixelIndex]!;
    if (weightSum > 1e-6) {
      blueDifferenceSum[pixelIndex] = blueDifferenceSum[pixelIndex]! / weightSum;
      redDifferenceSum[pixelIndex] = redDifferenceSum[pixelIndex]! / weightSum;
    }
  }
  const stackedImage = joinLuminanceAndChroma(size, {
    luminance: collapsedLevel.values,
    blueDifference: blueDifferenceSum,
    redDifference: redDifferenceSum,
  });
  const blendMilliseconds = now() - blendStartTime;

  let largestScaleDeviation = 0;
  let largestShift = 0;
  for (const transform of transforms) {
    largestScaleDeviation = Math.max(largestScaleDeviation, Math.abs(similarityScale(transform) - 1));
    largestShift = Math.max(largestShift, Math.hypot(transform.offsetX, transform.offsetY));
  }
  return {
    stackedImage,
    bestSingleImage,
    bestSingleFrameIndex,
    referenceFrameIndex,
    transforms,
    sourceIndexMap,
    confidenceMap,
    frameUsageFractions: usageCounts.map((usageCount) => usageCount / pixelCount),
    focusBreathingPercent: largestScaleDeviation * 100,
    maximumShiftPixels: largestShift,
    timings: { alignmentMilliseconds, sharpnessMilliseconds, blendMilliseconds, totalMilliseconds: now() - startTime },
  };
}

// ---------------------------------------------------------------------------------------------
// Mapa de profundidad en colores
// ---------------------------------------------------------------------------------------------

/** De cerca (rojo) a lejos (violeta). */
const depthPaletteStops: readonly (readonly [number, number, number])[] = [
  [220, 50, 47],
  [245, 150, 40],
  [235, 215, 60],
  [80, 190, 110],
  [40, 140, 220],
  [120, 80, 205],
];

/** Color de la foto `frameIndex` de `frameCount` (0 = la más cercana). */
export function depthColorForFrame(frameIndex: number, frameCount: number): [number, number, number] {
  const palettePosition = frameCount > 1 ? (frameIndex / (frameCount - 1)) * (depthPaletteStops.length - 1) : 0;
  const lowerStop = Math.min(depthPaletteStops.length - 2, Math.floor(palettePosition));
  const stopWeight = palettePosition - lowerStop;
  const lowerColor = depthPaletteStops[lowerStop]!;
  const upperColor = depthPaletteStops[lowerStop + 1]!;
  return [0, 1, 2].map((channelIndex) =>
    Math.round(lowerColor[channelIndex]! + stopWeight * (upperColor[channelIndex]! - lowerColor[channelIndex]!)),
  ) as [number, number, number];
}

/**
 * Mapa de «qué foto se usó» como imagen RGB (para el visor): el color de la foto elegida, fundido
 * con la propia escena en gris oscuro donde la elección no es fiable (zonas lisas).
 */
export function renderSourceIndexMap(result: FocusStackResult, frameCount: number): FloatRgbImage {
  const { size } = result.stackedImage;
  const pixelCount = size * size;
  const paletteColors = Array.from({ length: frameCount }, (_unused, frameIndex) => depthColorForFrame(frameIndex, frameCount));
  const channels = new Float32Array(pixelCount * 3);
  const stackedChannels = result.stackedImage.channels;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const paletteColor = paletteColors[result.sourceIndexMap[pixelIndex]!] ?? paletteColors[0]!;
    const confidence = result.confidenceMap[pixelIndex]!;
    const sceneGray =
      0.35 * (0.299 * stackedChannels[pixelIndex * 3]! + 0.587 * stackedChannels[pixelIndex * 3 + 1]! + 0.114 * stackedChannels[pixelIndex * 3 + 2]!);
    // Aun con confianza alta se deja ver algo de la escena, para reconocer qué es cada zona.
    const colorWeight = 0.25 + 0.75 * confidence;
    for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
      channels[pixelIndex * 3 + channelIndex] = colorWeight * paletteColor[channelIndex]! + (1 - colorWeight) * sceneGray;
    }
  }
  return { size, channels };
}
