/**
 * Bandas de fracción de octava (IEC 61260, base 10): la forma estándar de resumir un espectro
 * en pocos números comparables entre mediciones, independientes del tamaño de la FFT.
 */

export interface FrequencyBand {
  centerHz: number;
  lowerEdgeHz: number;
  upperEdgeHz: number;
}

const octaveRatio = 10 ** (3 / 10);

/**
 * Bandas de 1/`bandsPerOctave` de octava con centro entre `minimumCenterHz` y `maximumCenterHz`.
 * Con `bandsPerOctave = 3` salen los tercios de octava normalizados (…, 100, 125, 160, 200 Hz…).
 */
export function createFractionalOctaveBands(
  bandsPerOctave: number,
  minimumCenterHz: number,
  maximumCenterHz: number,
): FrequencyBand[] {
  if (!(bandsPerOctave >= 1) || !(minimumCenterHz > 0) || !(maximumCenterHz >= minimumCenterHz)) {
    throw new RangeError('Parámetros de bandas no válidos');
  }
  const bands: FrequencyBand[] = [];
  const halfBandFactor = octaveRatio ** (1 / (2 * bandsPerOctave));
  // Índice x tal que el centro es 1000 · G^(x / b); se recorre de la primera a la última banda.
  const firstBandIndex = Math.ceil(bandsPerOctave * Math.log(minimumCenterHz / 1000) / Math.log(octaveRatio) - 1e-9);
  const lastBandIndex = Math.floor(bandsPerOctave * Math.log(maximumCenterHz / 1000) / Math.log(octaveRatio) + 1e-9);
  for (let bandIndex = firstBandIndex; bandIndex <= lastBandIndex; bandIndex++) {
    const centerHz = 1000 * octaveRatio ** (bandIndex / bandsPerOctave);
    bands.push({ centerHz, lowerEdgeHz: centerHz / halfBandFactor, upperEdgeHz: centerHz * halfBandFactor });
  }
  return bands;
}

/**
 * Potencia de cada banda sumando los bins cuyo centro cae dentro, a partir de un espectro de
 * amplitud de un solo lado (como el de computeAmplitudeSpectrum). Devuelve potencias lineales
 * (amplitud²); una banda sin bins (demasiado estrecha para la resolución) da 0.
 */
export function bandPowersFromAmplitudeSpectrum(
  amplitudes: ArrayLike<number>,
  sampleRateHz: number,
  fftSize: number,
  bands: readonly FrequencyBand[],
): Float64Array {
  const binResolutionHz = sampleRateHz / fftSize;
  const bandPowers = new Float64Array(bands.length);
  bands.forEach((band, bandIndex) => {
    const firstBin = Math.max(1, Math.ceil(band.lowerEdgeHz / binResolutionHz));
    const lastBin = Math.min(amplitudes.length - 1, Math.floor(band.upperEdgeHz / binResolutionHz - 1e-9));
    let powerSum = 0;
    for (let binIndex = firstBin; binIndex <= lastBin; binIndex++) {
      const binAmplitude = amplitudes[binIndex]!;
      // Una senoidal de amplitud A tiene potencia A²/2.
      powerSum += (binAmplitude * binAmplitude) / 2;
    }
    bandPowers[bandIndex] = powerSum;
  });
  return bandPowers;
}

/** Potencia → dB con suelo, para no devolver −∞ en bandas vacías. */
export function powerToDecibels(power: number, floorDecibels = -200): number {
  return power > 0 ? Math.max(floorDecibels, 10 * Math.log10(power)) : floorDecibels;
}

/** Serie de números preferentes R10: los valores nominales de los tercios de octava. */
const nominalMantissas = [1, 1.25, 1.6, 2, 2.5, 3.15, 4, 5, 6.3, 8, 10];

/**
 * Etiqueta corta con el valor nominal normalizado de la banda: 31.5, 125, 1k, 12.5k…
 * (el centro exacto de base 10 es 125,89 Hz, pero la norma lo nombra «125»).
 */
export function formatBandCenter(centerHz: number): string {
  const decade = 10 ** Math.floor(Math.log10(centerHz));
  const mantissa = centerHz / decade;
  const nearestMantissa = nominalMantissas.reduce((bestMantissa, candidateMantissa) =>
    Math.abs(Math.log(candidateMantissa / mantissa)) < Math.abs(Math.log(bestMantissa / mantissa))
      ? candidateMantissa
      : bestMantissa,
  );
  const nominalHz = Number((nearestMantissa * decade).toPrecision(3));
  return nominalHz >= 1000 ? `${Number((nominalHz / 1000).toPrecision(3))}k` : `${nominalHz}`;
}
