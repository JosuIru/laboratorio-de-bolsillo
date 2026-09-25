/**
 * Frecuencia fundamental por el método de McLeod (MPM, «A smarter way to find pitch», 2005).
 *
 * Trabaja en el dominio del tiempo con la función de diferencia cuadrática normalizada (NSDF):
 * vale 1 cuando la señal se repite exactamente con ese retardo. El periodo es el primer máximo
 * que llega cerca del máximo global, lo que evita saltar a la octava de abajo. Con interpolación
 * parabólica del máximo da precisión de fracciones de centésima, que la FFT no alcanza en notas
 * graves con ventanas cortas.
 */

import { createFftPlan, type FftPlan, fftInPlace, inverseFftInPlace } from './fft';

export interface PitchEstimate {
  frequencyHz: number;
  /** Altura del máximo de la NSDF (0…1): cuánto se parece la señal a sí misma un periodo después. */
  clarity: number;
  /** Nivel RMS de la ventana, para descartar silencios. */
  rootMeanSquare: number;
}

export interface McLeodPitchOptions {
  sampleRateHz: number;
  minimumFrequencyHz: number;
  maximumFrequencyHz: number;
  /** Fracción del máximo global que debe alcanzar un máximo para ser el elegido (0,8–0,95). */
  peakThresholdFraction?: number;
  /** Nivel RMS mínimo (señal en [−1, 1]) para intentar detectar. */
  minimumRootMeanSquare?: number;
}

const fftPlansBySize = new Map<number, FftPlan>();

function fftPlanForSize(size: number): FftPlan {
  let fftPlan = fftPlansBySize.get(size);
  if (!fftPlan) {
    fftPlan = createFftPlan(size);
    fftPlansBySize.set(size, fftPlan);
  }
  return fftPlan;
}

/**
 * NSDF de `samples` para retardos de 0 a `maximumLag`:
 * n(τ) = 2·Σ x[j]·x[j+τ] / Σ (x[j]² + x[j+τ]²).
 * La autocorrelación sale de la FFT (|X|² y vuelta, con relleno de ceros para que no se
 * enrosque) y la energía, de sumas acumuladas: O(N log N) en vez de O(N·τ).
 */
export function normalizedSquareDifference(samples: ArrayLike<number>, maximumLag: number): Float64Array {
  const sampleCount = samples.length;
  const lagCount = Math.min(maximumLag, sampleCount - 1) + 1;
  let paddedSize = 2;
  while (paddedSize < 2 * sampleCount) paddedSize *= 2;
  const fftPlan = fftPlanForSize(paddedSize);
  const realPart = new Float64Array(paddedSize);
  const imaginaryPart = new Float64Array(paddedSize);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) realPart[sampleIndex] = samples[sampleIndex]!;
  fftInPlace(fftPlan, realPart, imaginaryPart);
  for (let binIndex = 0; binIndex < paddedSize; binIndex++) {
    realPart[binIndex] = realPart[binIndex]! ** 2 + imaginaryPart[binIndex]! ** 2;
    imaginaryPart[binIndex] = 0;
  }
  inverseFftInPlace(fftPlan, realPart, imaginaryPart);

  // cumulativeEnergy[k] = Σ x[j]² para j < k.
  const cumulativeEnergy = new Float64Array(sampleCount + 1);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    cumulativeEnergy[sampleIndex + 1] = cumulativeEnergy[sampleIndex]! + samples[sampleIndex]! ** 2;
  }
  const totalEnergy = cumulativeEnergy[sampleCount]!;

  const nsdfValues = new Float64Array(lagCount);
  for (let lag = 0; lag < lagCount; lag++) {
    const energySum = cumulativeEnergy[sampleCount - lag]! + totalEnergy - cumulativeEnergy[lag]!;
    nsdfValues[lag] = energySum > 0 ? (2 * realPart[lag]!) / energySum : 0;
  }
  return nsdfValues;
}

/** Vértice de la parábola que pasa por el máximo y sus vecinos: posición y altura. */
function parabolicPeak(values: ArrayLike<number>, peakIndex: number): { position: number; height: number } {
  if (peakIndex <= 0 || peakIndex >= values.length - 1) return { position: peakIndex, height: values[peakIndex]! };
  const leftValue = values[peakIndex - 1]!;
  const peakValue = values[peakIndex]!;
  const rightValue = values[peakIndex + 1]!;
  const curvature = leftValue - 2 * peakValue + rightValue;
  if (curvature >= 0) return { position: peakIndex, height: peakValue };
  const offset = (0.5 * (leftValue - rightValue)) / curvature;
  return { position: peakIndex + offset, height: peakValue - 0.25 * (leftValue - rightValue) * offset };
}

export function estimatePitchMcLeod(samples: ArrayLike<number>, options: McLeodPitchOptions): PitchEstimate | null {
  const {
    sampleRateHz,
    minimumFrequencyHz,
    maximumFrequencyHz,
    peakThresholdFraction = 0.9,
    minimumRootMeanSquare = 0.003,
  } = options;

  let squaredSum = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) squaredSum += samples[sampleIndex]! ** 2;
  const rootMeanSquare = Math.sqrt(squaredSum / Math.max(1, samples.length));
  if (rootMeanSquare < minimumRootMeanSquare) return null;

  const minimumLag = Math.max(2, Math.floor(sampleRateHz / maximumFrequencyHz));
  // Hacen falta al menos dos periodos en la ventana para que la NSDF sea fiable.
  const maximumLag = Math.min(Math.ceil(sampleRateHz / minimumFrequencyHz), Math.floor(samples.length / 2));
  if (maximumLag <= minimumLag) return null;
  const nsdfValues = normalizedSquareDifference(samples, maximumLag + 1);

  // Máximos «clave»: el más alto entre cada cruce por cero ascendente y el siguiente descendente.
  const keyMaxima: { position: number; height: number }[] = [];
  let lagIndex = 1;
  // Salta el lóbulo inicial (retardo 0 vale 1): hasta el primer cruce por cero.
  while (lagIndex < nsdfValues.length && nsdfValues[lagIndex]! > 0) lagIndex++;
  while (lagIndex < nsdfValues.length - 1) {
    while (lagIndex < nsdfValues.length - 1 && nsdfValues[lagIndex]! <= 0) lagIndex++;
    let bestLagInLobe = -1;
    while (lagIndex < nsdfValues.length - 1 && nsdfValues[lagIndex]! > 0) {
      if (bestLagInLobe < 0 || nsdfValues[lagIndex]! > nsdfValues[bestLagInLobe]!) bestLagInLobe = lagIndex;
      lagIndex++;
    }
    // Un lóbulo cortado por el final del array no tiene su máximo real dentro: se descarta.
    const isLobeClosed = lagIndex < nsdfValues.length - 1;
    if (isLobeClosed && bestLagInLobe >= minimumLag && bestLagInLobe <= maximumLag) {
      keyMaxima.push(parabolicPeak(nsdfValues, bestLagInLobe));
    }
  }
  if (keyMaxima.length === 0) return null;

  const highestMaximum = Math.max(...keyMaxima.map((keyMaximum) => keyMaximum.height));
  const chosenMaximum = keyMaxima.find((keyMaximum) => keyMaximum.height >= peakThresholdFraction * highestMaximum)!;
  if (chosenMaximum.position <= 0) return null;
  return {
    frequencyHz: sampleRateHz / chosenMaximum.position,
    clarity: Math.min(1, chosenMaximum.height),
    rootMeanSquare,
  };
}
