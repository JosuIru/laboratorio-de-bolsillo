import { createFftPlan, type FftPlan, fftInPlace, inverseFftInPlace } from '@/processing/dsp/fft';

/**
 * Filtro adaptado (correlación cruzada con el chirp emitido) calculado en frecuencia:
 *
 *   envolvente[k] = | IFFT( X(f) · conj(C(f)) · H(f) ) | / energía del chirp
 *
 * H(f) hace dos cosas a la vez: es un paso banda (anula todo fuera de la banda del chirp, así
 * que el ruido grave de la sala no entra) y deja solo las frecuencias positivas duplicadas, con
 * lo que la IFFT da directamente la señal analítica y su módulo es la envolvente (sin Hilbert
 * aparte). Una copia del chirp con amplitud `a` produce un pico de envolvente ≈ `a`.
 */
export interface MatchedFilter {
  plan: FftPlan;
  fftSize: number;
  chirpLength: number;
  /** Espectro del filtro: conj(C)·H / energía. */
  filterReal: Float64Array;
  filterImaginary: Float64Array;
  /** Buffers de trabajo reutilizables. */
  workReal: Float64Array;
  workImaginary: Float64Array;
}

export interface MatchedFilterOptions {
  chirpSamples: Float32Array;
  fftSize: number;
  sampleRateHz: number;
  passbandLowHz: number;
  passbandHighHz: number;
  /** Margen a cada lado de la banda del chirp (las rampas ensanchan un poco su espectro). */
  passbandMarginHz?: number;
}

export function createMatchedFilter(options: MatchedFilterOptions): MatchedFilter {
  const { chirpSamples, fftSize, sampleRateHz, passbandLowHz, passbandHighHz, passbandMarginHz = 500 } = options;
  if (chirpSamples.length > fftSize) throw new RangeError('El chirp no cabe en la FFT');
  const plan = createFftPlan(fftSize);
  const filterReal = new Float64Array(fftSize);
  const filterImaginary = new Float64Array(fftSize);
  let chirpEnergy = 0;
  for (let sampleIndex = 0; sampleIndex < chirpSamples.length; sampleIndex++) {
    const chirpValue = chirpSamples[sampleIndex]!;
    filterReal[sampleIndex] = chirpValue;
    chirpEnergy += chirpValue * chirpValue;
  }
  if (!(chirpEnergy > 0)) throw new RangeError('El chirp no tiene energía');
  fftInPlace(plan, filterReal, filterImaginary);

  const binResolutionHz = sampleRateHz / fftSize;
  const firstPassBin = Math.max(1, Math.floor((passbandLowHz - passbandMarginHz) / binResolutionHz));
  const lastPassBin = Math.min(fftSize / 2 - 1, Math.ceil((passbandHighHz + passbandMarginHz) / binResolutionHz));
  for (let binIndex = 0; binIndex < fftSize; binIndex++) {
    const isInPassband = binIndex >= firstPassBin && binIndex <= lastPassBin;
    // Conjugado (correlación en vez de convolución), ×2 por la señal analítica, ÷ energía.
    const binGain = isInPassband ? 2 / chirpEnergy : 0;
    filterImaginary[binIndex] = -filterImaginary[binIndex]! * binGain;
    filterReal[binIndex] = filterReal[binIndex]! * binGain;
  }

  return {
    plan,
    fftSize,
    chirpLength: chirpSamples.length,
    filterReal,
    filterImaginary,
    workReal: new Float64Array(fftSize),
    workImaginary: new Float64Array(fftSize),
  };
}

/**
 * Envolvente de la correlación de `segment` con el chirp: `envelopeOutput[k]` indica cuánto se
 * parece al chirp lo que empieza en la muestra `k`. Devuelve cuántos retardos son válidos
 * (los demás mezclarían el final con el principio por ser una correlación circular).
 */
export function computeCorrelationEnvelope(
  matchedFilter: MatchedFilter,
  segment: ArrayLike<number>,
  envelopeOutput: Float64Array,
): number {
  'worklet';
  const { plan, fftSize, chirpLength, filterReal, filterImaginary, workReal, workImaginary } = matchedFilter;
  const usedLength = Math.min(segment.length, fftSize);
  for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex++) {
    workReal[sampleIndex] = sampleIndex < usedLength ? segment[sampleIndex]! : 0;
    workImaginary[sampleIndex] = 0;
  }
  fftInPlace(plan, workReal, workImaginary);
  for (let binIndex = 0; binIndex < fftSize; binIndex++) {
    const signalReal = workReal[binIndex]!;
    const signalImaginary = workImaginary[binIndex]!;
    workReal[binIndex] = signalReal * filterReal[binIndex]! - signalImaginary * filterImaginary[binIndex]!;
    workImaginary[binIndex] = signalReal * filterImaginary[binIndex]! + signalImaginary * filterReal[binIndex]!;
  }
  inverseFftInPlace(plan, workReal, workImaginary);
  const validLagCount = Math.max(0, usedLength - chirpLength + 1);
  for (let lagIndex = 0; lagIndex < envelopeOutput.length; lagIndex++) {
    envelopeOutput[lagIndex] = lagIndex < validLagCount ? Math.hypot(workReal[lagIndex]!, workImaginary[lagIndex]!) : 0;
  }
  return validLagCount;
}

/** Siguiente potencia de 2 mayor o igual que `minimumSize`. */
export function nextPowerOfTwo(minimumSize: number): number {
  let powerOfTwo = 1;
  while (powerOfTwo < minimumSize) powerOfTwo *= 2;
  return powerOfTwo;
}
