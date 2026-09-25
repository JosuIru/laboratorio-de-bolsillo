/**
 * Instante de comienzo de una palmada (o de un globo que explota) con precisión de submuestra.
 *
 * Dos pasos:
 * 1. Grueso: flujo espectral de `dsp/onsets` con tramas cortas. Da el golpe con una resolución de
 *    ~1 ms y permite distinguir la palmada de otros ruidos (se queda con el primero de los golpes
 *    fuertes: el sonido directo llega antes que sus rebotes).
 * 2. Fino: selector AIC (criterio de información de Akaike, el habitual para picar la llegada de
 *    ondas en sismología). Divide un tramo corto en «ruido» y «señal» por el punto que mejor
 *    explica el cambio de varianza. No depende de un umbral de amplitud, así que un móvil lejano
 *    (que oye la palmada más débil) no la marca más tarde que uno cercano. El mínimo del AIC se
 *    afina con una parábola para bajar de una muestra.
 *
 * Antes se quita lo grave (paso alto a 300 Hz, dos etapas): el ruido de ventiladores, tráfico o
 * del propio móvil al tocarlo está casi todo por debajo, y la palmada tiene su energía en 1-4 kHz.
 * El filtro retrasa igual la palmada en todos los móviles, así que no afecta a las diferencias.
 */

import { createBiquadState, designBiquad, processBiquadBlock } from '@/processing/dsp/biquad';
import { computeSpectralFlux, pickOnsets } from '@/processing/dsp/onsets';

export interface ClapOnset {
  /** Índice (fraccionario) de la muestra del comienzo, en el array analizado. */
  onsetSampleIndex: number;
  /** RMS de los 5 ms tras el comienzo dividido por el del ruido anterior. */
  signalToNoiseRatio: number;
  /** Amplitud máxima (0-1) en los 20 ms tras el comienzo: cerca de 1, el micrófono satura. */
  peakAmplitude: number;
  /** Hay otro golpe casi tan fuerte en la ventana: puede que se haya elegido el que no era. */
  hasCompetingOnset: boolean;
}

export interface ClapOnsetOptions {
  highPassCutoffHz?: number;
  /** Relación señal/ruido mínima para aceptar el golpe. */
  minimumSignalToNoiseRatio?: number;
}

const fluxFrameSize = 512;
const fluxHopSize = 64;
const filterSettlingSeconds = 0.02;
/** Un golpe cuenta como «fuerte» si su flujo llega a esta fracción del más fuerte. */
const strongOnsetFraction = 0.5;
/** Golpes fuertes más separados que esto se consideran sucesos distintos (no ecos). */
const competingOnsetSeparationSeconds = 0.15;

/**
 * Selector AIC sobre `values[firstIndex, endIndex)`. Devuelve la posición (fraccionaria) de la
 * primera muestra de la señal, o `null` si el tramo es demasiado corto.
 */
export function pickOnsetByAkaikeCriterion(values: ArrayLike<number>, firstIndex: number, endIndex: number): number | null {
  const windowLength = endIndex - firstIndex;
  const minimumSideLength = 8;
  if (windowLength < 3 * minimumSideLength) return null;
  const prefixSum = new Float64Array(windowLength + 1);
  const prefixSquareSum = new Float64Array(windowLength + 1);
  for (let offset = 0; offset < windowLength; offset++) {
    const sampleValue = values[firstIndex + offset]!;
    prefixSum[offset + 1] = prefixSum[offset]! + sampleValue;
    prefixSquareSum[offset + 1] = prefixSquareSum[offset]! + sampleValue * sampleValue;
  }
  const varianceOf = (startOffset: number, endOffset: number) => {
    const count = endOffset - startOffset;
    const mean = (prefixSum[endOffset]! - prefixSum[startOffset]!) / count;
    const variance = (prefixSquareSum[endOffset]! - prefixSquareSum[startOffset]!) / count - mean * mean;
    return Math.max(variance, 1e-20);
  };
  // aic[k]: el ruido ocupa [0, k) y la señal [k, N).
  const aicValues = new Float64Array(windowLength + 1).fill(Infinity);
  let bestSplit = -1;
  for (let splitOffset = minimumSideLength; splitOffset <= windowLength - minimumSideLength; splitOffset++) {
    const aicValue =
      splitOffset * Math.log(varianceOf(0, splitOffset)) +
      (windowLength - splitOffset) * Math.log(varianceOf(splitOffset, windowLength));
    aicValues[splitOffset] = aicValue;
    if (bestSplit < 0 || aicValue < aicValues[bestSplit]!) bestSplit = splitOffset;
  }
  if (bestSplit < 0) return null;
  let fractionalOffset = 0;
  const leftValue = aicValues[bestSplit - 1]!;
  const rightValue = aicValues[bestSplit + 1]!;
  if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
    const curvature = leftValue - 2 * aicValues[bestSplit]! + rightValue;
    if (curvature > 0) fractionalOffset = Math.max(-0.5, Math.min(0.5, (0.5 * (leftValue - rightValue)) / curvature));
  }
  return firstIndex + bestSplit + fractionalOffset;
}

function rootMeanSquare(values: ArrayLike<number>, firstIndex: number, endIndex: number): number {
  const clampedFirst = Math.max(0, firstIndex);
  const clampedEnd = Math.min(values.length, endIndex);
  if (clampedEnd <= clampedFirst) return 0;
  let squareSum = 0;
  for (let sampleIndex = clampedFirst; sampleIndex < clampedEnd; sampleIndex++) squareSum += values[sampleIndex]! ** 2;
  return Math.sqrt(squareSum / (clampedEnd - clampedFirst));
}

/**
 * Busca la palmada que empieza entre `searchStartIndex` y `searchEndIndex` de `samples`.
 * Devuelve `null` si no hay ningún golpe claro.
 */
export function locateClapOnset(
  samples: ArrayLike<number>,
  searchStartIndex: number,
  searchEndIndex: number,
  sampleRateHz: number,
  options: ClapOnsetOptions = {},
): ClapOnset | null {
  const { highPassCutoffHz = 300, minimumSignalToNoiseRatio = 4 } = options;
  const settlingSamples = Math.round(filterSettlingSeconds * sampleRateHz);
  const filterStartIndex = Math.max(0, searchStartIndex - settlingSamples - fluxFrameSize);
  const regionEndIndex = Math.min(samples.length, searchEndIndex + fluxFrameSize);
  const filteredLength = regionEndIndex - filterStartIndex;
  // Lo que el filtro necesita para asentarse se filtra pero no se analiza.
  const analysisStartOffset = Math.min(settlingSamples, Math.max(0, searchStartIndex - fluxFrameSize - filterStartIndex));
  if (filteredLength - analysisStartOffset < 4 * fluxFrameSize) return null;

  const filteredSamples = new Float64Array(filteredLength);
  for (let offset = 0; offset < filteredLength; offset++) filteredSamples[offset] = samples[filterStartIndex + offset]!;
  const highPassCoefficients = designBiquad('high-pass', highPassCutoffHz, sampleRateHz);
  processBiquadBlock(highPassCoefficients, createBiquadState(), filteredSamples, filteredSamples);
  processBiquadBlock(highPassCoefficients, createBiquadState(), filteredSamples, filteredSamples);
  const regionStartIndex = filterStartIndex + analysisStartOffset;
  const filteredRegion = filteredSamples.subarray(analysisStartOffset);
  const regionLength = filteredRegion.length;

  const spectralFlux = computeSpectralFlux(filteredRegion, sampleRateHz, {
    frameSize: fluxFrameSize,
    hopSize: fluxHopSize,
  });
  const onsetTimesSeconds = pickOnsets(spectralFlux, {
    thresholdOffset: 0.15,
    localWindowSeconds: 0.03,
    minimumIntervalSeconds: 0.03,
    minimumFlux: 0.5,
  });
  const firstAllowedOffset = searchStartIndex - regionStartIndex;
  const endAllowedOffset = searchEndIndex - regionStartIndex;
  const candidateOnsets = onsetTimesSeconds
    .map((onsetTimeSeconds) => {
      const frameIndex = Math.round((onsetTimeSeconds - spectralFlux.firstFrameCenterSeconds) / spectralFlux.hopSeconds);
      return {
        frameCenterOffset: Math.round(onsetTimeSeconds * sampleRateHz),
        fluxValue: spectralFlux.fluxValues[frameIndex] ?? 0,
      };
    })
    .filter(
      (candidate) =>
        candidate.frameCenterOffset >= firstAllowedOffset && candidate.frameCenterOffset < endAllowedOffset,
    );
  if (candidateOnsets.length === 0) return null;

  const strongestFlux = Math.max(...candidateOnsets.map((candidate) => candidate.fluxValue));
  const strongOnsets = candidateOnsets.filter((candidate) => candidate.fluxValue >= strongOnsetFraction * strongestFlux);
  const chosenOnset = strongOnsets[0]!;
  const competingSeparationSamples = competingOnsetSeparationSeconds * sampleRateHz;
  const hasCompetingOnset = strongOnsets.some(
    (candidate) => candidate.frameCenterOffset - chosenOnset.frameCenterOffset > competingSeparationSamples,
  );

  // El golpe está dentro de la trama del flujo (o un poco antes, por la ventana de Hann).
  const aicFirstOffset = Math.max(0, chosenOnset.frameCenterOffset - Math.round(1.5 * fluxFrameSize));
  const aicEndOffset = Math.min(regionLength, chosenOnset.frameCenterOffset + fluxFrameSize / 2);
  const onsetOffset = pickOnsetByAkaikeCriterion(filteredRegion, aicFirstOffset, aicEndOffset);
  if (onsetOffset === null) return null;

  const roundedOnsetOffset = Math.round(onsetOffset);
  const noiseRootMeanSquare = rootMeanSquare(filteredRegion, aicFirstOffset, roundedOnsetOffset - 2);
  const signalRootMeanSquare = rootMeanSquare(
    filteredRegion,
    roundedOnsetOffset,
    roundedOnsetOffset + Math.round(0.005 * sampleRateHz),
  );
  const signalToNoiseRatio = signalRootMeanSquare / Math.max(noiseRootMeanSquare, 1e-9);
  if (signalToNoiseRatio < minimumSignalToNoiseRatio) return null;

  let peakAmplitude = 0;
  const peakEndIndex = Math.min(samples.length, regionStartIndex + roundedOnsetOffset + Math.round(0.02 * sampleRateHz));
  for (let sampleIndex = regionStartIndex + roundedOnsetOffset; sampleIndex < peakEndIndex; sampleIndex++) {
    peakAmplitude = Math.max(peakAmplitude, Math.abs(samples[sampleIndex]!));
  }

  return {
    onsetSampleIndex: regionStartIndex + onsetOffset,
    signalToNoiseRatio,
    peakAmplitude,
    hasCompetingOnset,
  };
}
