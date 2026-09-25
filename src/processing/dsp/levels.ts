/** Umbral inferior para no devolver −∞ dB con silencio digital. */
export const minimumDecibels = -160;

export function rootMeanSquare(samples: ArrayLike<number>, startIndex = 0, endIndex = samples.length): number {
  'worklet';
  const sampleCount = endIndex - startIndex;
  if (sampleCount <= 0) return 0;
  let squaredSum = 0;
  for (let sampleIndex = startIndex; sampleIndex < endIndex; sampleIndex++) {
    squaredSum += samples[sampleIndex]! * samples[sampleIndex]!;
  }
  return Math.sqrt(squaredSum / sampleCount);
}

export function peakAbsolute(samples: ArrayLike<number>): number {
  'worklet';
  let peakValue = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const absoluteValue = Math.abs(samples[sampleIndex]!);
    if (absoluteValue > peakValue) peakValue = absoluteValue;
  }
  return peakValue;
}

/** Amplitud → decibelios respecto a `referenceAmplitude` (20·log10). */
export function amplitudeToDecibels(amplitude: number, referenceAmplitude = 1): number {
  'worklet';
  if (!(amplitude > 0)) return minimumDecibels;
  return Math.max(minimumDecibels, 20 * Math.log10(amplitude / referenceAmplitude));
}

export function decibelsToAmplitude(decibels: number, referenceAmplitude = 1): number {
  'worklet';
  return referenceAmplitude * 10 ** (decibels / 20);
}

/**
 * Nivel en dBFS de audio normalizado a [−1, 1]. Convención AES17: una senoidal de fondo
 * de escala da 0 dBFS (su RMS es 1/√2, así que se suman 3,01 dB).
 */
export function rmsToDecibelsFullScale(rmsValue: number): number {
  'worklet';
  return amplitudeToDecibels(rmsValue * Math.SQRT2);
}

/**
 * Nivel de presión sonora aproximado: dBFS + desplazamiento de calibración del micrófono.
 * Sin calibrar con un sonómetro de referencia, el valor es solo orientativo.
 */
export function approximateSoundPressureLevel(decibelsFullScale: number, calibrationOffsetDecibels: number): number {
  'worklet';
  return decibelsFullScale + calibrationOffsetDecibels;
}

/** Convierte in situ un espectro de amplitud a decibelios. */
export function magnitudesToDecibelsInPlace(magnitudes: Float32Array | Float64Array, referenceAmplitude = 1): void {
  'worklet';
  for (let binIndex = 0; binIndex < magnitudes.length; binIndex++) {
    magnitudes[binIndex] = amplitudeToDecibels(magnitudes[binIndex]!, referenceAmplitude);
  }
}
