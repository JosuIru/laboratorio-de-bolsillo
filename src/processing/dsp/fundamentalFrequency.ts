/**
 * Frecuencia fundamental de un sonido armónico (motor, ventilador, cuerda, voz).
 *
 * El pico más alto del espectro no siempre es la fundamental: el segundo o el tercer armónico
 * pueden sonar más. Aquí cada pico claro del espectro es candidato, y se puntúa por cuánto
 * destacan sus armónicos (×1, ×2, ×3…). La fundamental real «explica» más picos que cualquiera
 * de sus armónicos, así que gana aunque su propio pico sea más débil.
 *
 * A diferencia del producto espectral armónico clásico, la fundamental tiene que ser un pico
 * real: así un tono puro no se confunde con su suboctava, a cambio de no detectar la
 * «fundamental ausente» (rara en máquinas, donde la rotación casi siempre suena).
 */

export interface FundamentalEstimate {
  frequencyHz: number;
  /** Bin del pico de la fundamental en el espectro original. */
  binIndex: number;
  /** Cuántos dB supera el pico de la fundamental a la mediana del espectro (el suelo de ruido). */
  prominenceDecibels: number;
  /** Armónicos (incluida la fundamental) que destacan del ruido. */
  detectedHarmonicCount: number;
}

export interface FundamentalFrequencyOptions {
  sampleRateHz: number;
  fftSize: number;
  minimumFrequencyHz: number;
  maximumFrequencyHz: number;
  /** Armónicos que se miran por candidato (incluida la fundamental). */
  harmonicCount?: number;
  /** dB sobre la mediana para que un pico cuente como tono y no como ruido. */
  minimumProminenceDecibels?: number;
  /** Peso de cada armónico respecto al anterior: los altos importan algo menos. */
  harmonicWeightDecay?: number;
}

const amplitudeFloor = 1e-12;

function amplitudeToDecibels(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitudeFloor, amplitude));
}

function medianOf(values: Float64Array): number {
  const sortedValues = Float64Array.from(values).sort();
  const middleIndex = sortedValues.length >> 1;
  return sortedValues.length % 2 === 1
    ? sortedValues[middleIndex]!
    : (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
}

/** Posición fraccionaria del pico por interpolación parabólica entre el bin y sus vecinos. */
function refinePeakBin(amplitudes: ArrayLike<number>, peakBin: number): number {
  if (peakBin <= 0 || peakBin >= amplitudes.length - 1) return peakBin;
  const leftAmplitude = amplitudes[peakBin - 1]!;
  const peakAmplitude = amplitudes[peakBin]!;
  const rightAmplitude = amplitudes[peakBin + 1]!;
  const curvature = leftAmplitude - 2 * peakAmplitude + rightAmplitude;
  return curvature < 0 ? peakBin + (0.5 * (leftAmplitude - rightAmplitude)) / curvature : peakBin;
}

/**
 * `amplitudes`: espectro de amplitud de un solo lado (bin k = k·fs/N), lineal, no en dB.
 * Devuelve `null` si no hay ningún tono claro en el rango.
 */
export function estimateFundamentalFrequency(
  amplitudes: ArrayLike<number>,
  options: FundamentalFrequencyOptions,
): FundamentalEstimate | null {
  const {
    sampleRateHz,
    fftSize,
    minimumFrequencyHz,
    maximumFrequencyHz,
    harmonicCount = 5,
    minimumProminenceDecibels = 12,
    harmonicWeightDecay = 0.85,
  } = options;
  const binWidthHz = sampleRateHz / fftSize;
  const spectrumDecibels = new Float64Array(amplitudes.length);
  for (let binIndex = 0; binIndex < amplitudes.length; binIndex++) {
    spectrumDecibels[binIndex] = amplitudeToDecibels(amplitudes[binIndex]!);
  }
  const noiseFloorDecibels = medianOf(spectrumDecibels.subarray(1));
  const prominenceAt = (binIndex: number) => spectrumDecibels[binIndex]! - noiseFloorDecibels;

  const firstBin = Math.max(1, Math.ceil(minimumFrequencyHz / binWidthHz));
  const lastBin = Math.min(amplitudes.length - 2, Math.floor(maximumFrequencyHz / binWidthHz));

  let bestEstimate: FundamentalEstimate | null = null;
  let bestScore = 0;
  for (let candidateBin = firstBin; candidateBin <= lastBin; candidateBin++) {
    const candidateAmplitude = amplitudes[candidateBin]!;
    const isLocalPeak =
      candidateAmplitude >= amplitudes[candidateBin - 1]! && candidateAmplitude > amplitudes[candidateBin + 1]!;
    if (!isLocalPeak || prominenceAt(candidateBin) < minimumProminenceDecibels) continue;

    const refinedCandidateBin = refinePeakBin(amplitudes, candidateBin);
    let harmonicScore = 0;
    let detectedHarmonicCount = 0;
    for (let harmonicNumber = 1; harmonicNumber <= harmonicCount; harmonicNumber++) {
      const expectedBin = Math.round(refinedCandidateBin * harmonicNumber);
      if (expectedBin >= amplitudes.length) break;
      // El error del candidato se multiplica con el armónico: se busca en ±1 bin.
      let harmonicBin = expectedBin;
      for (const neighborBin of [expectedBin - 1, expectedBin + 1]) {
        if (neighborBin > 0 && neighborBin < amplitudes.length && amplitudes[neighborBin]! > amplitudes[harmonicBin]!) {
          harmonicBin = neighborBin;
        }
      }
      const harmonicProminence = prominenceAt(harmonicBin);
      if (harmonicProminence >= minimumProminenceDecibels) detectedHarmonicCount++;
      harmonicScore += Math.max(0, harmonicProminence) * harmonicWeightDecay ** (harmonicNumber - 1);
    }

    if (harmonicScore > bestScore) {
      bestScore = harmonicScore;
      bestEstimate = {
        frequencyHz: refinedCandidateBin * binWidthHz,
        binIndex: candidateBin,
        prominenceDecibels: prominenceAt(candidateBin),
        detectedHarmonicCount,
      };
    }
  }
  return bestEstimate;
}
