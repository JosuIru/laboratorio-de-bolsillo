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
 *
 * La frecuencia no sale solo del bin de la fundamental: cada pico se afina con interpolación
 * parabólica sobre el espectro en dB, y luego se promedian las estimaciones fₖ/k de todos los
 * armónicos detectados. El error de posición de un pico (en bins) es parecido en todos, pero al
 * dividir por k el del armónico k pesa k veces menos: con varios armónicos la fundamental baja
 * de 50 Hz se mide mucho mejor que con su propio pico.
 */

export interface FundamentalEstimate {
  frequencyHz: number;
  /** Bin del pico de la fundamental en el espectro original. */
  binIndex: number;
  /** Cuántos dB supera el pico de la fundamental a la mediana del espectro (el suelo de ruido). */
  prominenceDecibels: number;
  /** Armónicos (incluida la fundamental) que destacan del ruido. */
  detectedHarmonicCount: number;
  /**
   * Incertidumbre típica (±1σ aproximada) de `frequencyHz`: el error residual de la interpolación
   * repartido entre los armónicos usados, o la discrepancia entre ellos si es mayor.
   */
  frequencyUncertaintyHz: number;
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

/**
 * Error residual de la interpolación parabólica en dB, en bins. Con ventanas de Hann o Blackman
 * el lóbulo principal en dB es casi una parábola y el sesgo queda por debajo de ~0,03 bins; se
 * redondea hacia arriba para cubrir el ruido y las ventanas cortas.
 */
const interpolationErrorBins = 0.05;

/**
 * Posición fraccionaria del pico por interpolación parabólica entre el bin y sus vecinos,
 * sobre el espectro en dB: con ventanas suaves es mucho más fiel que sobre la amplitud lineal.
 */
function refinePeakBin(spectrumDecibels: ArrayLike<number>, peakBin: number): number {
  if (peakBin <= 0 || peakBin >= spectrumDecibels.length - 1) return peakBin;
  const leftDecibels = spectrumDecibels[peakBin - 1]!;
  const peakDecibels = spectrumDecibels[peakBin]!;
  const rightDecibels = spectrumDecibels[peakBin + 1]!;
  const curvature = leftDecibels - 2 * peakDecibels + rightDecibels;
  if (!(curvature < 0)) return peakBin;
  const peakOffsetBins = (0.5 * (leftDecibels - rightDecibels)) / curvature;
  return Math.abs(peakOffsetBins) <= 0.5 ? peakBin + peakOffsetBins : peakBin;
}

/**
 * Un armónico solo afina la frecuencia si no está más de esto por debajo del más fuerte: los
 * lóbulos laterales de la ventana (−58 dB en Blackman) y sus restos no son armónicos.
 */
const maximumHarmonicLevelBelowStrongestDecibels = 40;

interface HarmonicPeak {
  harmonicNumber: number;
  /** Posición afinada del pico, en bins. */
  refinedBin: number;
  peakDecibels: number;
}

/**
 * Combina las estimaciones fₖ/k de los armónicos. Todas tienen el mismo error en bins antes de
 * dividir por k, así que la de k tiene varianza ∝ 1/k²: la media de mínima varianza pesa con k².
 */
function combineHarmonicEstimates(detectedHarmonicPeaks: readonly HarmonicPeak[], binWidthHz: number) {
  const strongestPeakDecibels = Math.max(...detectedHarmonicPeaks.map((harmonicPeak) => harmonicPeak.peakDecibels));
  const harmonicPeaks = detectedHarmonicPeaks.filter(
    (harmonicPeak) =>
      harmonicPeak.harmonicNumber === 1 ||
      harmonicPeak.peakDecibels >= strongestPeakDecibels - maximumHarmonicLevelBelowStrongestDecibels,
  );
  let weightSum = 0;
  let weightedFrequencySum = 0;
  for (const { harmonicNumber, refinedBin } of harmonicPeaks) {
    const harmonicWeight = harmonicNumber ** 2;
    weightSum += harmonicWeight;
    weightedFrequencySum += harmonicWeight * (refinedBin / harmonicNumber) * binWidthHz;
  }
  const frequencyHz = weightedFrequencySum / weightSum;
  // Error de interpolación de la media: σ_bins / √(Σk²).
  const interpolationUncertaintyHz = (interpolationErrorBins * binWidthHz) / Math.sqrt(weightSum);
  // Si los armónicos discrepan entre sí más de lo esperado (ruido, otro sonido cerca), manda eso.
  let weightedSquaredDeviationSum = 0;
  for (const { harmonicNumber, refinedBin } of harmonicPeaks) {
    const harmonicDeviationHz = (refinedBin / harmonicNumber) * binWidthHz - frequencyHz;
    weightedSquaredDeviationSum += harmonicNumber ** 2 * harmonicDeviationHz ** 2;
  }
  const disagreementUncertaintyHz =
    harmonicPeaks.length > 1 ? Math.sqrt(weightedSquaredDeviationSum / weightSum / (harmonicPeaks.length - 1)) : 0;
  return { frequencyHz, frequencyUncertaintyHz: Math.max(interpolationUncertaintyHz, disagreementUncertaintyHz) };
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

    const refinedCandidateBin = refinePeakBin(spectrumDecibels, candidateBin);
    let harmonicScore = 0;
    let detectedHarmonicCount = 0;
    let strongestHarmonicDecibels = -Infinity;
    const harmonicPeaks: HarmonicPeak[] = [
      { harmonicNumber: 1, refinedBin: refinedCandidateBin, peakDecibels: spectrumDecibels[candidateBin]! },
    ];
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
      if (harmonicProminence >= minimumProminenceDecibels) {
        detectedHarmonicCount++;
        const isHarmonicLocalPeak =
          harmonicBin + 1 < amplitudes.length &&
          amplitudes[harmonicBin]! >= amplitudes[harmonicBin - 1]! &&
          amplitudes[harmonicBin]! >= amplitudes[harmonicBin + 1]!;
        // Solo se usa para afinar si es un pico propio y cae cerca de donde se espera: el error
        // de la fundamental (unas décimas de bin como mucho) crece con k.
        const refinedHarmonicBin = refinePeakBin(spectrumDecibels, harmonicBin);
        const harmonicOffsetBins = Math.abs(refinedHarmonicBin - refinedCandidateBin * harmonicNumber);
        const maximumHarmonicOffsetBins = 0.25 + 0.1 * harmonicNumber;
        if (harmonicNumber > 1 && isHarmonicLocalPeak && harmonicOffsetBins <= maximumHarmonicOffsetBins) {
          harmonicPeaks.push({ harmonicNumber, refinedBin: refinedHarmonicBin, peakDecibels: spectrumDecibels[harmonicBin]! });
        }
      }
      harmonicScore += Math.max(0, harmonicProminence) * harmonicWeightDecay ** (harmonicNumber - 1);
      strongestHarmonicDecibels = Math.max(strongestHarmonicDecibels, spectrumDecibels[harmonicBin]!);
    }
    // Un «candidato» muy por debajo de sus supuestos armónicos es un lóbulo lateral de la ventana
    // alrededor de un tono fuerte, no una fundamental (si no, un tono puro sale a su suboctava).
    if (spectrumDecibels[candidateBin]! < strongestHarmonicDecibels - maximumHarmonicLevelBelowStrongestDecibels) continue;

    if (harmonicScore > bestScore) {
      bestScore = harmonicScore;
      bestEstimate = {
        ...combineHarmonicEstimates(harmonicPeaks, binWidthHz),
        binIndex: candidateBin,
        prominenceDecibels: prominenceAt(candidateBin),
        detectedHarmonicCount,
      };
    }
  }
  return bestEstimate;
}
