/**
 * Calibración del sensor tapado, en dos fases:
 *
 * 1. Ruido: se acumula el histograma del brillo de unos cuantos fotogramas negros y se calcula
 *    el nivel de negro y la dispersión del ruido. De ahí sale el umbral (cuánto por encima del
 *    negro tiene que estar un píxel para contar como semilla de un suceso).
 * 2. Píxeles calientes: con ese umbral, se anotan los píxeles que lo superan en cada fotograma.
 *    Una partícula casi nunca cae dos veces en el mismo píxel en unos segundos; un píxel caliente
 *    (defecto del sensor con más corriente de oscuridad) se enciende una y otra vez. Los que se
 *    repiten forman la máscara.
 *
 * Además, durante la medición el umbral se adapta (`adaptThresholdOffset`) y los píxeles que
 * empiezan a repetirse al calentarse el móvil se añaden a la máscara (`registerEventPeak`).
 *
 * Módulo puro: sin React ni React Native.
 */

export interface DarkNoiseSummary {
  sampleCount: number;
  /** Media del brillo (0-255). */
  meanBrightness: number;
  medianBrightness: number;
  /** Desviación típica sin el 0,01 % más brillante (los píxeles calientes y los impactos). */
  trimmedStandardDeviation: number;
}

/** Fracción más brillante del histograma que no cuenta para la dispersión del ruido. */
const trimmedBrightFraction = 1e-4;

export function summarizeDarkHistogram(histogram: ArrayLike<number>): DarkNoiseSummary {
  let sampleCount = 0;
  let brightnessSum = 0;
  for (let brightness = 0; brightness < histogram.length; brightness++) {
    sampleCount += histogram[brightness]!;
    brightnessSum += brightness * histogram[brightness]!;
  }
  if (sampleCount === 0) {
    return { sampleCount: 0, meanBrightness: 0, medianBrightness: 0, trimmedStandardDeviation: 0 };
  }

  let medianBrightness = 0;
  let cumulativeCount = 0;
  for (let brightness = 0; brightness < histogram.length; brightness++) {
    cumulativeCount += histogram[brightness]!;
    if (cumulativeCount >= sampleCount / 2) {
      medianBrightness = brightness;
      break;
    }
  }

  // Se quitan las muestras más brillantes empezando por arriba.
  let samplesToTrim = Math.floor(sampleCount * trimmedBrightFraction);
  let trimmedCount = 0;
  let trimmedSum = 0;
  let trimmedSquareSum = 0;
  for (let brightness = histogram.length - 1; brightness >= 0; brightness--) {
    let binCount = histogram[brightness]!;
    const trimmedFromBin = Math.min(binCount, samplesToTrim);
    samplesToTrim -= trimmedFromBin;
    binCount -= trimmedFromBin;
    trimmedCount += binCount;
    trimmedSum += brightness * binCount;
    trimmedSquareSum += brightness * brightness * binCount;
  }
  const trimmedMean = trimmedCount > 0 ? trimmedSum / trimmedCount : 0;
  const trimmedVariance = trimmedCount > 0 ? Math.max(0, trimmedSquareSum / trimmedCount - trimmedMean ** 2) : 0;

  return {
    sampleCount,
    meanBrightness: brightnessSum / sampleCount,
    medianBrightness,
    trimmedStandardDeviation: Math.sqrt(trimmedVariance),
  };
}

export interface ThresholdOptions {
  /** Desviaciones típicas del ruido por encima del negro. */
  noiseSigmaMultiple: number;
  /** Mínimo en niveles de 0-255: muchos móviles recortan el negro a 0 y la dispersión sale nula. */
  minimumOffset: number;
  maximumOffset: number;
}

export const defaultThresholdOptions: ThresholdOptions = {
  noiseSigmaMultiple: 7,
  minimumOffset: 16,
  maximumOffset: 160,
};

/** Cuánto por encima del nivel de negro de cada fotograma tiene que estar una semilla. */
export function thresholdOffsetFromNoise(
  noiseSummary: DarkNoiseSummary,
  options: ThresholdOptions = defaultThresholdOptions,
): number {
  const noiseOffset = Math.ceil(noiseSummary.trimmedStandardDeviation * options.noiseSigmaMultiple);
  return Math.min(options.maximumOffset, Math.max(options.minimumOffset, noiseOffset));
}

/** Nivel de negro máximo para dar la cámara por tapada. */
export const maximumCoveredDarkLevel = 25;

export function isCameraCovered(darkLevel: number): boolean {
  return darkLevel <= maximumCoveredDarkLevel;
}

/** Suma una aparición a cada píxel de la lista (fase de píxeles calientes). */
export function countPixelOccurrences(occurrenceCounts: Map<number, number>, pixelIndices: readonly number[]): void {
  for (const pixelIndex of pixelIndices) {
    occurrenceCounts.set(pixelIndex, (occurrenceCounts.get(pixelIndex) ?? 0) + 1);
  }
}

/** Píxeles que aparecen al menos `minimumOccurrences` veces, ordenados (para la búsqueda binaria). */
export function selectHotPixels(occurrenceCounts: ReadonlyMap<number, number>, minimumOccurrences: number): Int32Array {
  const hotPixelIndices: number[] = [];
  for (const [pixelIndex, occurrenceCount] of occurrenceCounts) {
    if (occurrenceCount >= minimumOccurrences) hotPixelIndices.push(pixelIndex);
  }
  return Int32Array.from(hotPixelIndices.sort((firstIndex, secondIndex) => firstIndex - secondIndex));
}

/** Une dos listas ordenadas de píxeles calientes sin repetir. */
export function mergeHotPixelIndices(sortedIndices: Int32Array, addedIndices: readonly number[]): Int32Array {
  const mergedIndices = new Set<number>(sortedIndices);
  for (const pixelIndex of addedIndices) mergedIndices.add(pixelIndex);
  return Int32Array.from([...mergedIndices].sort((firstIndex, secondIndex) => firstIndex - secondIndex));
}

/** Índices del píxel y sus 8 vecinos dentro del fotograma. */
export function neighbourhoodPixelIndices(pixelIndex: number, frameWidth: number, frameHeight: number): number[] {
  const rowIndex = Math.floor(pixelIndex / frameWidth);
  const columnIndex = pixelIndex - rowIndex * frameWidth;
  const neighbourIndices: number[] = [];
  for (let rowStep = -1; rowStep <= 1; rowStep++) {
    for (let columnStep = -1; columnStep <= 1; columnStep++) {
      const neighbourRow = rowIndex + rowStep;
      const neighbourColumn = columnIndex + columnStep;
      if (neighbourRow < 0 || neighbourRow >= frameHeight || neighbourColumn < 0 || neighbourColumn >= frameWidth) continue;
      neighbourIndices.push(neighbourRow * frameWidth + neighbourColumn);
    }
  }
  return neighbourIndices;
}

/**
 * Anota el píxel más brillante de un suceso. Devuelve `true` si ese píxel (o un vecino) ya ha
 * dado `repeatLimit` sucesos: es un píxel que se ha vuelto caliente, no una partícula.
 */
export function registerEventPeak(
  peakOccurrenceCounts: Map<number, number>,
  peakPixelIndex: number,
  frameWidth: number,
  frameHeight: number,
  repeatLimit: number,
): boolean {
  peakOccurrenceCounts.set(peakPixelIndex, (peakOccurrenceCounts.get(peakPixelIndex) ?? 0) + 1);
  let neighbourhoodCount = 0;
  for (const neighbourIndex of neighbourhoodPixelIndices(peakPixelIndex, frameWidth, frameHeight)) {
    neighbourhoodCount += peakOccurrenceCounts.get(neighbourIndex) ?? 0;
  }
  return neighbourhoodCount >= repeatLimit;
}

export interface ThresholdAdaptationOptions {
  /** Sucesos por fotograma por encima de los cuales el umbral es demasiado bajo. */
  maximumClustersPerFrame: number;
  raiseFactor: number;
  maximumOffset: number;
}

export const defaultThresholdAdaptationOptions: ThresholdAdaptationOptions = {
  // Las partículas reales dan del orden de 1 suceso cada miles de fotogramas: 1 cada 10 es ruido.
  maximumClustersPerFrame: 0.1,
  raiseFactor: 1.25,
  maximumOffset: defaultThresholdOptions.maximumOffset,
};

/**
 * Umbral adaptativo: si en la última tanda de fotogramas salen demasiados sucesos (el sensor se
 * ha calentado y hay más ruido), se sube el umbral. Nunca se baja durante una medición, para no
 * mezclar sensibilidades.
 */
export function adaptThresholdOffset(
  currentOffset: number,
  clusterCount: number,
  frameCount: number,
  options: ThresholdAdaptationOptions = defaultThresholdAdaptationOptions,
): number {
  if (frameCount <= 0) return currentOffset;
  if (clusterCount / frameCount <= options.maximumClustersPerFrame) return currentOffset;
  return Math.min(options.maximumOffset, Math.ceil(currentOffset * options.raiseFactor));
}
