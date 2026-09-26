import { createFftPlan, type FftPlan, fftInPlace } from '@/processing/dsp/fft';
import { findDominantFrequency } from '@/processing/dsp/spectrum';
import { createWindow } from '@/processing/dsp/windows';

import { type MeasurementRegion, regionCellBounds } from './measurementRegion';

/**
 * Modo de medida: frecuencia dominante de la zona de medida de la imagen (el recuadro).
 *
 * Se guarda la historia de unos cuantos píxeles (los de la zona de medida de la rejilla) con
 * la marca de tiempo de cada fotograma. Para estimar la frecuencia se remuestrea cada serie a
 * un paso uniforme (los fotogramas no llegan exactamente espaciados), se quita la tendencia, se
 * enventana con Hann y se calcula la FFT (con relleno de ceros). Dos formas de combinar píxeles:
 *
 * - `coherent`: se promedian los píxeles antes de la FFT. Es lo adecuado para un cambio de
 *   color que ocurre a la vez en toda la región (el pulso en la piel): el ruido se promedia.
 * - `incoherent`: se suman los espectros de potencia de los píxeles que más varían. Es lo
 *   adecuado para un movimiento: cada borde cambia con su propia fase y al promediar las
 *   señales se cancelarían, pero sus potencias sí se suman.
 */

export type PixelCombination = 'coherent' | 'incoherent';

export interface RegionHistory {
  capacity: number;
  valuesPerFrame: number;
  timesSeconds: Float64Array;
  values: Float32Array;
  /** Índice donde se escribirá el siguiente fotograma. */
  nextWriteIndex: number;
  storedFrameCount: number;
}

export function createRegionHistory(capacity: number, valuesPerFrame: number): RegionHistory {
  return {
    capacity,
    valuesPerFrame,
    timesSeconds: new Float64Array(capacity),
    values: new Float32Array(capacity * valuesPerFrame),
    nextWriteIndex: 0,
    storedFrameCount: 0,
  };
}

export function pushRegionFrame(history: RegionHistory, timeSeconds: number, frameValues: ArrayLike<number>): void {
  const { valuesPerFrame } = history;
  history.timesSeconds[history.nextWriteIndex] = timeSeconds;
  const writeStart = history.nextWriteIndex * valuesPerFrame;
  for (let valueIndex = 0; valueIndex < valuesPerFrame; valueIndex++) {
    history.values[writeStart + valueIndex] = frameValues[valueIndex]!;
  }
  history.nextWriteIndex = (history.nextWriteIndex + 1) % history.capacity;
  history.storedFrameCount = Math.min(history.capacity, history.storedFrameCount + 1);
}

export function clearRegionHistory(history: RegionHistory): void {
  history.nextWriteIndex = 0;
  history.storedFrameCount = 0;
}

/** Índice en el búfer circular del fotograma `orderIndex` (0 = el más antiguo). */
function storageIndexOf(history: RegionHistory, orderIndex: number): number {
  return (history.nextWriteIndex - history.storedFrameCount + orderIndex + history.capacity) % history.capacity;
}

/** Duración (s) de la historia guardada, del primer al último fotograma. */
export function regionHistoryDurationSeconds(history: RegionHistory): number {
  if (history.storedFrameCount < 2) return 0;
  return (
    history.timesSeconds[storageIndexOf(history, history.storedFrameCount - 1)]! -
    history.timesSeconds[storageIndexOf(history, 0)]!
  );
}

/**
 * Valores de la zona de medida de una rejilla (el rectángulo de `region`), del canal
 * `channelIndex`. Escribe en `outputValues` si se pasa (y tiene el tamaño justo).
 */
export function extractRegion(
  gridPixels: ArrayLike<number>,
  gridWidth: number,
  gridHeight: number,
  channelCount: number,
  channelIndex: number,
  region: MeasurementRegion,
  outputValues?: Float32Array,
): Float32Array {
  const { firstColumn, firstRow, regionWidth, regionHeight } = regionCellBounds(gridWidth, gridHeight, region);
  const regionValues =
    outputValues && outputValues.length === regionWidth * regionHeight
      ? outputValues
      : new Float32Array(regionWidth * regionHeight);
  for (let regionRow = 0; regionRow < regionHeight; regionRow++) {
    for (let regionColumn = 0; regionColumn < regionWidth; regionColumn++) {
      const gridIndex = (firstRow + regionRow) * gridWidth + firstColumn + regionColumn;
      regionValues[regionRow * regionWidth + regionColumn] = gridPixels[gridIndex * channelCount + channelIndex]!;
    }
  }
  return regionValues;
}

/**
 * Valores de la región central de una rejilla: el rectángulo centrado que ocupa
 * `regionFraction` de cada lado, del canal `channelIndex`.
 */
export function extractCentralRegion(
  gridPixels: ArrayLike<number>,
  gridWidth: number,
  gridHeight: number,
  channelCount: number,
  channelIndex: number,
  regionFraction: number,
): Float32Array {
  return extractRegion(gridPixels, gridWidth, gridHeight, channelCount, channelIndex, {
    centerXFraction: 0.5,
    centerYFraction: 0.5,
    sizeFraction: regionFraction,
  });
}

export interface DominantFrequencyOptions {
  minimumFrequencyHz: number;
  maximumFrequencyHz: number;
  combination: PixelCombination;
  /** En modo `incoherent`, cuántos píxeles (los de mayor varianza) se usan. */
  strongestSeriesCount?: number;
  /** Solo se analizan los últimos segundos de la historia (por defecto, toda). */
  windowSeconds?: number;
}

export interface DominantFrequencyEstimate {
  frequencyHz: number;
  /** Potencia del pico frente a la mediana de la banda: > 6 es un pico claro, < 3 es dudoso. */
  peakToMedianPowerRatio: number;
  sampleRateHz: number;
  durationSeconds: number;
  /** Espectro de amplitud (relativo) dentro de la banda, para dibujarlo. */
  bandFrequenciesHz: Float64Array;
  bandMagnitudes: Float64Array;
}

const fftPlanCache = new Map<number, FftPlan>();
function getFftPlan(fftSize: number): FftPlan {
  let fftPlan = fftPlanCache.get(fftSize);
  if (!fftPlan) {
    fftPlan = createFftPlan(fftSize);
    fftPlanCache.set(fftSize, fftPlan);
  }
  return fftPlan;
}

function nextPowerOfTwo(minimumValue: number): number {
  let powerOfTwo = 1;
  while (powerOfTwo < minimumValue) powerOfTwo *= 2;
  return powerOfTwo;
}

/** Remuestrea (interpolación lineal) una serie de tiempos irregulares a `uniformCount` puntos. */
function resampleUniformly(
  sampleTimes: Float64Array,
  sampleValues: Float64Array,
  startTime: number,
  samplePeriod: number,
  uniformValues: Float64Array,
): void {
  let sourceIndex = 0;
  for (let uniformIndex = 0; uniformIndex < uniformValues.length; uniformIndex++) {
    const targetTime = startTime + uniformIndex * samplePeriod;
    while (sourceIndex < sampleTimes.length - 2 && sampleTimes[sourceIndex + 1]! < targetTime) sourceIndex++;
    const leftTime = sampleTimes[sourceIndex]!;
    const rightTime = sampleTimes[sourceIndex + 1]!;
    const interpolationWeight =
      rightTime > leftTime ? Math.min(1, Math.max(0, (targetTime - leftTime) / (rightTime - leftTime))) : 0;
    uniformValues[uniformIndex] =
      sampleValues[sourceIndex]! + (sampleValues[sourceIndex + 1]! - sampleValues[sourceIndex]!) * interpolationWeight;
  }
}

/** Quita la recta de mínimos cuadrados (media y deriva lenta, p. ej. de la exposición). Devuelve la varianza residual. */
function removeLinearTrend(seriesValues: Float64Array): number {
  const sampleCount = seriesValues.length;
  const meanIndex = (sampleCount - 1) / 2;
  let valueSum = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) valueSum += seriesValues[sampleIndex]!;
  const meanValue = valueSum / sampleCount;
  let covarianceSum = 0;
  let indexVarianceSum = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    covarianceSum += (sampleIndex - meanIndex) * (seriesValues[sampleIndex]! - meanValue);
    indexVarianceSum += (sampleIndex - meanIndex) ** 2;
  }
  const slope = indexVarianceSum > 0 ? covarianceSum / indexVarianceSum : 0;
  let residualSquaredSum = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const residual = seriesValues[sampleIndex]! - meanValue - slope * (sampleIndex - meanIndex);
    seriesValues[sampleIndex] = residual;
    residualSquaredSum += residual * residual;
  }
  return residualSquaredSum / sampleCount;
}

/**
 * Frecuencia dominante dentro de la banda. Devuelve null si hay menos de dos periodos de la
 * frecuencia más baja de la banda o menos de 16 fotogramas.
 */
export function estimateDominantFrequency(
  history: RegionHistory,
  options: DominantFrequencyOptions,
): DominantFrequencyEstimate | null {
  const {
    minimumFrequencyHz,
    maximumFrequencyHz,
    combination,
    strongestSeriesCount = 32,
    windowSeconds = Infinity,
  } = options;
  if (history.storedFrameCount < 2) return null;
  const newestTime = history.timesSeconds[storageIndexOf(history, history.storedFrameCount - 1)]!;
  // Primer fotograma dentro de la ventana.
  let firstOrderIndex = 0;
  while (
    firstOrderIndex < history.storedFrameCount - 1 &&
    newestTime - history.timesSeconds[storageIndexOf(history, firstOrderIndex)]! > windowSeconds
  ) {
    firstOrderIndex++;
  }
  const frameCount = history.storedFrameCount - firstOrderIndex;
  const sampleTimes = new Float64Array(frameCount);
  for (let orderIndex = 0; orderIndex < frameCount; orderIndex++) {
    sampleTimes[orderIndex] = history.timesSeconds[storageIndexOf(history, firstOrderIndex + orderIndex)]!;
  }
  const startTime = sampleTimes[0]!;
  const durationSeconds = newestTime - startTime;
  if (frameCount < 16 || durationSeconds < 2 / minimumFrequencyHz) return null;

  const sampleRateHz = (frameCount - 1) / durationSeconds;
  const samplePeriod = 1 / sampleRateHz;
  const uniformCount = frameCount;

  const readSeries = (valueIndex: number | 'mean'): Float64Array => {
    const seriesValues = new Float64Array(frameCount);
    for (let orderIndex = 0; orderIndex < frameCount; orderIndex++) {
      const rowStart = storageIndexOf(history, firstOrderIndex + orderIndex) * history.valuesPerFrame;
      if (valueIndex === 'mean') {
        let rowSum = 0;
        for (let columnIndex = 0; columnIndex < history.valuesPerFrame; columnIndex++) {
          rowSum += history.values[rowStart + columnIndex]!;
        }
        seriesValues[orderIndex] = rowSum / history.valuesPerFrame;
      } else {
        seriesValues[orderIndex] = history.values[rowStart + valueIndex]!;
      }
    }
    const uniformValues = new Float64Array(uniformCount);
    resampleUniformly(sampleTimes, seriesValues, startTime, samplePeriod, uniformValues);
    return uniformValues;
  };

  // Series que entran en el análisis, ya remuestreadas y sin tendencia.
  let analyzedSeries: Float64Array[];
  if (combination === 'coherent') {
    const meanSeries = readSeries('mean');
    removeLinearTrend(meanSeries);
    analyzedSeries = [meanSeries];
  } else {
    const seriesWithVariance: { seriesValues: Float64Array; residualVariance: number }[] = [];
    for (let valueIndex = 0; valueIndex < history.valuesPerFrame; valueIndex++) {
      const seriesValues = readSeries(valueIndex);
      seriesWithVariance.push({ seriesValues, residualVariance: removeLinearTrend(seriesValues) });
    }
    seriesWithVariance.sort((left, right) => right.residualVariance - left.residualVariance);
    analyzedSeries = seriesWithVariance.slice(0, strongestSeriesCount).map((entry) => entry.seriesValues);
  }

  // Relleno de ceros hasta ≥ 2× la longitud: bins más finos para localizar el pico.
  const fftSize = Math.min(16384, nextPowerOfTwo(uniformCount * 2));
  const fftPlan = getFftPlan(fftSize);
  const hannWindow = createWindow('hann', uniformCount);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const summedPower = new Float64Array(fftSize / 2 + 1);
  for (const seriesValues of analyzedSeries) {
    real.fill(0);
    imaginary.fill(0);
    for (let sampleIndex = 0; sampleIndex < uniformCount; sampleIndex++) {
      real[sampleIndex] = seriesValues[sampleIndex]! * hannWindow.coefficients[sampleIndex]!;
    }
    fftInPlace(fftPlan, real, imaginary);
    for (let binIndex = 0; binIndex <= fftSize / 2; binIndex++) {
      summedPower[binIndex] = summedPower[binIndex]! + real[binIndex]! ** 2 + imaginary[binIndex]! ** 2;
    }
  }

  const amplitudeScale = 2 / (uniformCount * hannWindow.coherentGain * Math.sqrt(analyzedSeries.length));
  const magnitudes = new Float64Array(summedPower.length);
  for (let binIndex = 0; binIndex < summedPower.length; binIndex++) {
    magnitudes[binIndex] = Math.sqrt(summedPower[binIndex]!) * amplitudeScale;
  }

  const limitedMaximumFrequencyHz = Math.min(maximumFrequencyHz, sampleRateHz / 2);
  const dominantFrequency = findDominantFrequency(
    magnitudes,
    sampleRateHz,
    fftSize,
    minimumFrequencyHz,
    limitedMaximumFrequencyHz,
  );
  if (!dominantFrequency) return null;

  const firstBandBin = Math.max(1, Math.ceil((minimumFrequencyHz * fftSize) / sampleRateHz));
  const lastBandBin = Math.min(fftSize / 2, Math.floor((limitedMaximumFrequencyHz * fftSize) / sampleRateHz));
  const bandBinCount = Math.max(0, lastBandBin - firstBandBin + 1);
  const bandFrequenciesHz = new Float64Array(bandBinCount);
  const bandMagnitudes = new Float64Array(bandBinCount);
  const bandPowers: number[] = [];
  for (let bandIndex = 0; bandIndex < bandBinCount; bandIndex++) {
    const binIndex = firstBandBin + bandIndex;
    bandFrequenciesHz[bandIndex] = (binIndex * sampleRateHz) / fftSize;
    bandMagnitudes[bandIndex] = magnitudes[binIndex]!;
    bandPowers.push(magnitudes[binIndex]! ** 2);
  }
  bandPowers.sort((left, right) => left - right);
  const medianBandPower = bandPowers[Math.floor(bandPowers.length / 2)] ?? 0;
  const peakPower = dominantFrequency.amplitude ** 2;

  return {
    frequencyHz: dominantFrequency.frequencyHz,
    peakToMedianPowerRatio: medianBandPower > 0 ? peakPower / medianBandPower : Infinity,
    sampleRateHz,
    durationSeconds,
    bandFrequenciesHz,
    bandMagnitudes,
  };
}
