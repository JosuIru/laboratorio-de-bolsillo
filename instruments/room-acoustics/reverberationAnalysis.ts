import { createBiquadState, designBiquad, processBiquadBlock } from '@/processing/dsp/biquad';

/**
 * Tiempo de reverberación a partir de la respuesta a un golpe (palmada, globo), por el método de
 * la integral inversa de Schroeder (ISO 3382): se filtra por bandas de octava, se calcula la
 * envolvente de energía, se le resta el ruido de fondo, se integra hacia atrás desde donde la
 * cola se hunde en el ruido y se ajusta una recta a la curva en dB.
 */

export const octaveBandCentersHz = [125, 250, 500, 1000, 2000, 4000] as const;
export type OctaveBandCenterHz = (typeof octaveBandCentersHz)[number];

/** Resolución de la envolvente: bloques de 10 ms. */
const envelopeBlockSeconds = 0.01;
/** Q de un pasabanda de una octava de ancho. */
const octaveBandQuality = Math.SQRT2;
/** La cola se corta donde queda a menos de esto por encima del ruido de fondo. */
const truncationMarginDecibels = 5;

export type DecayParameterId = 'edt' | 't20' | 't30';

/** Tramo de la curva de Schroeder que se ajusta para cada parámetro (dB bajo el máximo). */
const decayFitRanges: Record<DecayParameterId, { startDecibels: number; endDecibels: number }> = {
  edt: { startDecibels: 0, endDecibels: -10 },
  t20: { startDecibels: -5, endDecibels: -25 },
  t30: { startDecibels: -5, endDecibels: -35 },
};

/** ISO 3382: el ruido de fondo debe quedar al menos 10 dB por debajo del final del tramo ajustado. */
const noiseMarginBelowFitEndDecibels = 10;

/** Por debajo de este coeficiente de correlación la caída no es una recta: el valor no es fiable. */
export const minimumFitCorrelation = 0.97;

export interface DecayFit {
  /** Tiempo de reverberación extrapolado a 60 dB, en segundos. */
  reverberationTimeSeconds: number;
  /** Coeficiente de correlación (en valor absoluto) de la recta ajustada. */
  correlation: number;
}

export interface BandReverberation {
  /** null = banda completa (sin filtrar). */
  centerHz: OctaveBandCenterHz | null;
  /** Diferencia entre el máximo del golpe y el ruido de fondo, en dB. */
  dynamicRangeDecibels: number;
  edt: DecayFit | null;
  t20: DecayFit | null;
  t30: DecayFit | null;
}

/** Energía media de bloques consecutivos (señal al cuadrado), en dB. */
export function energyEnvelopeDecibels(samples: ArrayLike<number>, samplesPerBlock: number): Float64Array {
  const blockCount = Math.floor(samples.length / samplesPerBlock);
  const envelopeDecibels = new Float64Array(blockCount);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    let energySum = 0;
    const firstSample = blockIndex * samplesPerBlock;
    for (let sampleIndex = firstSample; sampleIndex < firstSample + samplesPerBlock; sampleIndex++) {
      energySum += samples[sampleIndex]! ** 2;
    }
    envelopeDecibels[blockIndex] = 10 * Math.log10(Math.max(1e-20, energySum / samplesPerBlock));
  }
  return envelopeDecibels;
}

/** Filtra por la banda de octava (dos pasabanda en cascada: más selectivo que uno solo). */
export function filterOctaveBand(samples: ArrayLike<number>, centerHz: number, sampleRateHz: number): Float64Array {
  const bandCoefficients = designBiquad('band-pass', centerHz, sampleRateHz, octaveBandQuality);
  const filteredSamples = new Float64Array(samples.length);
  processBiquadBlock(bandCoefficients, createBiquadState(), samples, filteredSamples);
  processBiquadBlock(bandCoefficients, createBiquadState(), filteredSamples, filteredSamples);
  return filteredSamples;
}

function fitDecayLine(
  schroederDecibels: ArrayLike<number>,
  blockSeconds: number,
  startDecibels: number,
  endDecibels: number,
): DecayFit | null {
  let firstBlock = -1;
  let lastBlock = -1;
  for (let blockIndex = 0; blockIndex < schroederDecibels.length; blockIndex++) {
    if (firstBlock < 0 && schroederDecibels[blockIndex]! <= startDecibels) firstBlock = blockIndex;
    if (schroederDecibels[blockIndex]! >= endDecibels) lastBlock = blockIndex;
    else break;
  }
  // La curva tiene que llegar hasta el final del tramo, con al menos tres puntos.
  if (firstBlock < 0 || lastBlock < firstBlock + 2 || lastBlock + 1 >= schroederDecibels.length) return null;

  const pointCount = lastBlock - firstBlock + 1;
  let timeSum = 0;
  let levelSum = 0;
  for (let blockIndex = firstBlock; blockIndex <= lastBlock; blockIndex++) {
    timeSum += blockIndex * blockSeconds;
    levelSum += schroederDecibels[blockIndex]!;
  }
  const meanTime = timeSum / pointCount;
  const meanLevel = levelSum / pointCount;
  let covariance = 0;
  let timeVariance = 0;
  let levelVariance = 0;
  for (let blockIndex = firstBlock; blockIndex <= lastBlock; blockIndex++) {
    const timeDeviation = blockIndex * blockSeconds - meanTime;
    const levelDeviation = schroederDecibels[blockIndex]! - meanLevel;
    covariance += timeDeviation * levelDeviation;
    timeVariance += timeDeviation ** 2;
    levelVariance += levelDeviation ** 2;
  }
  const slopeDecibelsPerSecond = covariance / timeVariance;
  if (!(slopeDecibelsPerSecond < 0)) return null;
  return {
    reverberationTimeSeconds: -60 / slopeDecibelsPerSecond,
    correlation: levelVariance > 0 ? Math.abs(covariance / Math.sqrt(timeVariance * levelVariance)) : 0,
  };
}

/**
 * Parámetros de caída de una señal ya filtrada. `noiseSamples` es un tramo de solo ruido de
 * fondo (grabado antes del golpe); `responseSamples` empieza un poco antes del golpe.
 */
export function analyzeDecay(
  responseSamples: ArrayLike<number>,
  noiseSamples: ArrayLike<number>,
  sampleRateHz: number,
): Omit<BandReverberation, 'centerHz'> {
  const samplesPerBlock = Math.max(1, Math.round(envelopeBlockSeconds * sampleRateHz));
  const blockSeconds = samplesPerBlock / sampleRateHz;
  const envelopeDecibels = energyEnvelopeDecibels(responseSamples, samplesPerBlock);
  const noiseEnvelopeDecibels = energyEnvelopeDecibels(noiseSamples, samplesPerBlock);
  const emptyResult = {
    dynamicRangeDecibels: 0,
    edt: null,
    t20: null,
    t30: null,
  };
  if (envelopeDecibels.length < 3 || noiseEnvelopeDecibels.length === 0) return emptyResult;

  const noiseEnergy =
    noiseEnvelopeDecibels.reduce((energySum, blockDecibels) => energySum + 10 ** (blockDecibels / 10), 0) /
    noiseEnvelopeDecibels.length;
  const noiseDecibels = 10 * Math.log10(Math.max(1e-20, noiseEnergy));

  let peakBlock = 0;
  for (let blockIndex = 1; blockIndex < envelopeDecibels.length; blockIndex++) {
    if (envelopeDecibels[blockIndex]! > envelopeDecibels[peakBlock]!) peakBlock = blockIndex;
  }
  const dynamicRangeDecibels = envelopeDecibels[peakBlock]! - noiseDecibels;

  // Punto de corte: el primer bloque tras el máximo que ya está casi en el ruido de fondo.
  let truncationBlock = envelopeDecibels.length;
  for (let blockIndex = peakBlock + 1; blockIndex < envelopeDecibels.length; blockIndex++) {
    if (envelopeDecibels[blockIndex]! <= noiseDecibels + truncationMarginDecibels) {
      truncationBlock = blockIndex;
      break;
    }
  }

  // Integral inversa de la energía sin el ruido, desde el corte hasta el máximo.
  const decayBlockCount = truncationBlock - peakBlock;
  if (decayBlockCount < 3) return { ...emptyResult, dynamicRangeDecibels };
  const backwardEnergy = new Float64Array(decayBlockCount);
  let accumulatedEnergy = 0;
  for (let decayIndex = decayBlockCount - 1; decayIndex >= 0; decayIndex--) {
    const blockEnergy = 10 ** (envelopeDecibels[peakBlock + decayIndex]! / 10);
    accumulatedEnergy += Math.max(0, blockEnergy - noiseEnergy);
    backwardEnergy[decayIndex] = accumulatedEnergy;
  }
  const totalEnergy = backwardEnergy[0]!;
  if (!(totalEnergy > 0)) return { ...emptyResult, dynamicRangeDecibels };
  const schroederDecibels = backwardEnergy.map(
    (remainingEnergy) => 10 * Math.log10(Math.max(1e-20, remainingEnergy / totalEnergy)),
  );

  const fitParameter = (parameterId: DecayParameterId) =>
    dynamicRangeDecibels < -decayFitRanges[parameterId].endDecibels + noiseMarginBelowFitEndDecibels
      ? null
      : fitDecayLine(
          schroederDecibels,
          blockSeconds,
          decayFitRanges[parameterId].startDecibels,
          decayFitRanges[parameterId].endDecibels,
        );
  return {
    dynamicRangeDecibels,
    edt: fitParameter('edt'),
    t20: fitParameter('t20'),
    t30: fitParameter('t30'),
  };
}

/** Análisis de la banda completa y de cada octava que cabe bajo Nyquist. */
export function analyzeRoomResponse(
  responseSamples: ArrayLike<number>,
  noiseSamples: ArrayLike<number>,
  sampleRateHz: number,
): BandReverberation[] {
  const broadbandResult: BandReverberation = {
    centerHz: null,
    ...analyzeDecay(responseSamples, noiseSamples, sampleRateHz),
  };
  const bandResults = octaveBandCentersHz
    .filter((centerHz) => centerHz * Math.SQRT2 < sampleRateHz / 2)
    .map((centerHz): BandReverberation => ({
      centerHz,
      ...analyzeDecay(
        filterOctaveBand(responseSamples, centerHz, sampleRateHz),
        filterOctaveBand(noiseSamples, centerHz, sampleRateHz),
        sampleRateHz,
      ),
    }));
  return [broadbandResult, ...bandResults];
}

/** El mejor valor fiable de una banda: T30, si no T20 (el EDT no es un tiempo de reverberación). */
export function preferredReverberationTime(
  bandReverberation: BandReverberation,
): { parameterId: 't30' | 't20'; decayFit: DecayFit } | null {
  for (const parameterId of ['t30', 't20'] as const) {
    const decayFit = bandReverberation[parameterId];
    if (decayFit && decayFit.correlation >= minimumFitCorrelation) return { parameterId, decayFit };
  }
  return null;
}

/**
 * Tiempo de reverberación de frecuencias medias (media de 500 Hz y 1 kHz), el número que se suele
 * dar de una sala. Null si alguna de las dos bandas no tiene un valor fiable.
 */
export function midFrequencyReverberationTime(bandResults: readonly BandReverberation[]): number | null {
  const midBandTimes = [500, 1000].map((centerHz) => {
    const bandResult = bandResults.find((candidateBand) => candidateBand.centerHz === centerHz);
    return bandResult ? (preferredReverberationTime(bandResult)?.decayFit.reverberationTimeSeconds ?? null) : null;
  });
  if (midBandTimes.some((bandTime) => bandTime === null)) return null;
  return (midBandTimes[0]! + midBandTimes[1]!) / 2;
}

export type RoomCharacter = 'very-dry' | 'dry' | 'balanced' | 'reverberant' | 'very-reverberant';

/** Descripción orientativa para salas pequeñas y medianas (casas, aulas, locales de ensayo). */
export function describeRoomCharacter(midReverberationSeconds: number): RoomCharacter {
  if (midReverberationSeconds < 0.3) return 'very-dry';
  if (midReverberationSeconds < 0.5) return 'dry';
  if (midReverberationSeconds < 0.9) return 'balanced';
  if (midReverberationSeconds < 1.5) return 'reverberant';
  return 'very-reverberant';
}
