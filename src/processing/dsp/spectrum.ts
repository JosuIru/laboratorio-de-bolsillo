import { type FftPlan, fftInPlace } from './fft';

/**
 * Buffers de trabajo reutilizables para no reservar memoria en cada trama
 * (importante a 50-100 tramas por segundo en un worklet).
 */
export interface SpectrumWorkspace {
  real: Float64Array;
  imaginary: Float64Array;
  /** Espectro de un solo lado: `size / 2 + 1` bins, de 0 Hz a Nyquist. */
  magnitudes: Float64Array;
}

export function createSpectrumWorkspace(fftSize: number): SpectrumWorkspace {
  return {
    real: new Float64Array(fftSize),
    imaginary: new Float64Array(fftSize),
    magnitudes: new Float64Array(fftSize / 2 + 1),
  };
}

/**
 * Espectro de amplitud de un solo lado de una señal real. Una senoidal de amplitud A en un
 * bin exacto da `A` en ese bin (corrige la ganancia coherente de la ventana).
 * Resta la media antes de enventanar para que la componente continua no tape las bajas frecuencias.
 */
export function computeAmplitudeSpectrum(
  plan: FftPlan,
  samples: ArrayLike<number>,
  windowCoefficients: Float64Array,
  windowCoherentGain: number,
  workspace: SpectrumWorkspace,
  shouldRemoveMean = true,
): Float64Array {
  'worklet';
  const { size } = plan;
  const { real, imaginary, magnitudes } = workspace;

  let sampleMean = 0;
  if (shouldRemoveMean) {
    for (let sampleIndex = 0; sampleIndex < size; sampleIndex++) sampleMean += samples[sampleIndex]!;
    sampleMean /= size;
  }
  for (let sampleIndex = 0; sampleIndex < size; sampleIndex++) {
    real[sampleIndex] = (samples[sampleIndex]! - sampleMean) * windowCoefficients[sampleIndex]!;
    imaginary[sampleIndex] = 0;
  }

  fftInPlace(plan, real, imaginary);

  const halfSize = size / 2;
  const amplitudeScale = 1 / (size * windowCoherentGain);
  for (let binIndex = 0; binIndex <= halfSize; binIndex++) {
    const binMagnitude = Math.hypot(real[binIndex]!, imaginary[binIndex]!) * amplitudeScale;
    // Los bins intermedios reciben también la energía de su espejo (frecuencias negativas).
    magnitudes[binIndex] = binIndex === 0 || binIndex === halfSize ? binMagnitude : 2 * binMagnitude;
  }
  return magnitudes;
}

export function binFrequencyHz(binIndex: number, sampleRateHz: number, fftSize: number): number {
  'worklet';
  return (binIndex * sampleRateHz) / fftSize;
}

/** Bin más cercano a una frecuencia (acotado al rango válido). */
export function frequencyToBin(frequencyHz: number, sampleRateHz: number, fftSize: number): number {
  'worklet';
  return Math.max(0, Math.min(fftSize / 2, Math.round((frequencyHz * fftSize) / sampleRateHz)));
}

export interface DominantFrequency {
  frequencyHz: number;
  amplitude: number;
  binIndex: number;
}

/**
 * Pico más alto del espectro dentro de [minimumFrequencyHz, maximumFrequencyHz], con
 * interpolación parabólica entre bins vecinos para afinar más allá de la resolución de la FFT.
 */
export function findDominantFrequency(
  magnitudes: ArrayLike<number>,
  sampleRateHz: number,
  fftSize: number,
  minimumFrequencyHz = 0,
  maximumFrequencyHz = sampleRateHz / 2,
): DominantFrequency | null {
  'worklet';
  const firstBin = Math.max(1, frequencyToBin(minimumFrequencyHz, sampleRateHz, fftSize));
  const lastBin = Math.min(magnitudes.length - 1, frequencyToBin(maximumFrequencyHz, sampleRateHz, fftSize));

  let peakBin = -1;
  let peakMagnitude = 0;
  for (let binIndex = firstBin; binIndex <= lastBin; binIndex++) {
    if (magnitudes[binIndex]! > peakMagnitude) {
      peakMagnitude = magnitudes[binIndex]!;
      peakBin = binIndex;
    }
  }
  if (peakBin < 0) return null;

  let binOffset = 0;
  if (peakBin > 0 && peakBin < magnitudes.length - 1) {
    const leftMagnitude = magnitudes[peakBin - 1]!;
    const rightMagnitude = magnitudes[peakBin + 1]!;
    const curvature = leftMagnitude - 2 * peakMagnitude + rightMagnitude;
    if (curvature < 0) binOffset = (0.5 * (leftMagnitude - rightMagnitude)) / curvature;
  }

  return {
    frequencyHz: binFrequencyHz(peakBin + binOffset, sampleRateHz, fftSize),
    amplitude: peakMagnitude,
    binIndex: peakBin,
  };
}
