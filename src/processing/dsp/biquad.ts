/**
 * Filtros biquad (segundo orden) según el "Audio EQ Cookbook" de R. Bristow-Johnson.
 * Útiles para quitar la gravedad del acelerómetro (paso alto) o el ruido (paso bajo).
 */

export type BiquadKind = 'low-pass' | 'high-pass' | 'band-pass';

/** Coeficientes normalizados (a0 = 1). */
export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Estado interno (forma directa II transpuesta). */
export interface BiquadState {
  firstDelay: number;
  secondDelay: number;
}

/** Q de Butterworth: respuesta plana en la banda de paso. */
export const butterworthQuality = Math.SQRT1_2;

export function designBiquad(
  kind: BiquadKind,
  cutoffFrequencyHz: number,
  sampleRateHz: number,
  quality = butterworthQuality,
): BiquadCoefficients {
  if (!(cutoffFrequencyHz > 0 && cutoffFrequencyHz < sampleRateHz / 2)) {
    throw new RangeError(`La frecuencia de corte debe estar entre 0 y Nyquist (${sampleRateHz / 2} Hz)`);
  }
  if (!(quality > 0)) throw new RangeError('Q debe ser positivo');

  const angularFrequency = (2 * Math.PI * cutoffFrequencyHz) / sampleRateHz;
  const cosine = Math.cos(angularFrequency);
  const alpha = Math.sin(angularFrequency) / (2 * quality);

  let b0: number;
  let b1: number;
  let b2: number;
  switch (kind) {
    case 'low-pass':
      b0 = (1 - cosine) / 2;
      b1 = 1 - cosine;
      b2 = (1 - cosine) / 2;
      break;
    case 'high-pass':
      b0 = (1 + cosine) / 2;
      b1 = -(1 + cosine);
      b2 = (1 + cosine) / 2;
      break;
    case 'band-pass':
      // Ganancia de pico 0 dB.
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      break;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cosine) / a0, a2: (1 - alpha) / a0 };
}

export function createBiquadState(): BiquadState {
  return { firstDelay: 0, secondDelay: 0 };
}

export function processBiquadSample(coefficients: BiquadCoefficients, state: BiquadState, inputSample: number): number {
  'worklet';
  const outputSample = coefficients.b0 * inputSample + state.firstDelay;
  state.firstDelay = coefficients.b1 * inputSample - coefficients.a1 * outputSample + state.secondDelay;
  state.secondDelay = coefficients.b2 * inputSample - coefficients.a2 * outputSample;
  return outputSample;
}

/** Filtra un bloque; `output` puede ser el mismo array que `input`. */
export function processBiquadBlock(
  coefficients: BiquadCoefficients,
  state: BiquadState,
  input: ArrayLike<number>,
  output: Float32Array | Float64Array,
): void {
  'worklet';
  for (let sampleIndex = 0; sampleIndex < input.length; sampleIndex++) {
    output[sampleIndex] = processBiquadSample(coefficients, state, input[sampleIndex]!);
  }
}

/** Ganancia teórica del filtro a una frecuencia (módulo de H(e^jω)). */
export function biquadGainAt(coefficients: BiquadCoefficients, frequencyHz: number, sampleRateHz: number): number {
  const angularFrequency = (2 * Math.PI * frequencyHz) / sampleRateHz;
  const cosine1 = Math.cos(angularFrequency);
  const sine1 = Math.sin(angularFrequency);
  const cosine2 = Math.cos(2 * angularFrequency);
  const sine2 = Math.sin(2 * angularFrequency);
  const numeratorReal = coefficients.b0 + coefficients.b1 * cosine1 + coefficients.b2 * cosine2;
  const numeratorImaginary = -(coefficients.b1 * sine1 + coefficients.b2 * sine2);
  const denominatorReal = 1 + coefficients.a1 * cosine1 + coefficients.a2 * cosine2;
  const denominatorImaginary = -(coefficients.a1 * sine1 + coefficients.a2 * sine2);
  return Math.hypot(numeratorReal, numeratorImaginary) / Math.hypot(denominatorReal, denominatorImaginary);
}
