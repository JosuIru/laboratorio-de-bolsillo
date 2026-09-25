import type { LinearRgb } from '@/processing/color/colorSpaces';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';

// ── Modelo espectral de la cerveza ──────────────────────────────────────────────────────────
//
// Absorbancia de la cerveza según deLange (media de 99 cervezas normalizada a 430 nm, base de la
// guía de color del BJCP): A(λ) = SRM / 12,7 · l · (0,02465·e^(−(λ−430)/17,591) + 0,97535·e^(−(λ−430)/82,122)),
// con l en centímetros. La transmitancia es 10^(−A).

const firstWavelengthNm = 380;
const lastWavelengthNm = 730;
const wavelengthStepNm = 5;

/** Absorbancia de 1 cm de una cerveza de 1 SRM a la longitud de onda dada. */
export function deLangeAbsorbancePerSrm(wavelengthNm: number): number {
  const offsetNm = wavelengthNm - 430;
  return (0.02465 * Math.exp(-offsetNm / 17.591) + 0.97535 * Math.exp(-offsetNm / 82.122)) / 12.7;
}

type CameraChannel = 'red' | 'green' | 'blue';
const cameraChannels: readonly CameraChannel[] = ['red', 'green', 'blue'];

/**
 * Sensibilidad aproximada de cada canal de la cámara ya convertido a sRGB: una gaussiana centrada
 * en la longitud de onda dominante del primario sRGB. Es una aproximación: cada sensor es distinto,
 * y por eso el resultado es orientativo mientras no se valide con cervezas de color conocido.
 */
const channelSensitivities: Record<CameraChannel, { centerNm: number; widthNm: number }> = {
  red: { centerNm: 610, widthNm: 25 },
  green: { centerNm: 545, widthNm: 30 },
  blue: { centerNm: 465, widthNm: 22 },
};

const sampledWavelengthsNm = Array.from(
  { length: (lastWavelengthNm - firstWavelengthNm) / wavelengthStepNm + 1 },
  (_, wavelengthIndex) => firstWavelengthNm + wavelengthIndex * wavelengthStepNm,
);

const channelWeightsByWavelength: Record<CameraChannel, number[]> = Object.fromEntries(
  cameraChannels.map((channel) => {
    const { centerNm, widthNm } = channelSensitivities[channel];
    const unnormalizedWeights = sampledWavelengthsNm.map((wavelengthNm) =>
      Math.exp(-0.5 * ((wavelengthNm - centerNm) / widthNm) ** 2),
    );
    const weightSum = unnormalizedWeights.reduce((partialSum, weight) => partialSum + weight, 0);
    return [channel, unnormalizedWeights.map((weight) => weight / weightSum)];
  }),
) as Record<CameraChannel, number[]>;

const absorbancePerSrmByWavelength = sampledWavelengthsNm.map(deLangeAbsorbancePerSrm);

/** Transmitancia que vería cada canal a través de `pathLengthCm` de una cerveza de `srm`. */
export function predictBeerTransmittance(srm: number, pathLengthCm: number): LinearRgb {
  const channelTransmittance = (channel: CameraChannel) =>
    channelWeightsByWavelength[channel].reduce(
      (partialSum, weight, wavelengthIndex) =>
        partialSum + weight * 10 ** (-srm * pathLengthCm * absorbancePerSrmByWavelength[wavelengthIndex]!),
      0,
    );
  return { red: channelTransmittance('red'), green: channelTransmittance('green'), blue: channelTransmittance('blue') };
}

// ── Transmitancia medida ────────────────────────────────────────────────────────────────────

/** Por encima, el papel está quemado en ese canal y la transmitancia sale falsa. */
export const overexposedPaperLinear = 0.95;
/** Por debajo, hay tan poca luz que el ruido del sensor manda. */
export const underexposedPaperLinear = 0.08;
/** Transmitancia mínima que se tiene en cuenta: por debajo, el canal es casi solo ruido. */
const transmittanceFloor = 0.005;

export type ExposureProblem = 'paper-overexposed' | 'paper-underexposed' | 'sample-brighter-than-paper' | 'too-dark';

export interface TransmittanceMeasurement {
  transmittance: LinearRgb;
  problems: ExposureProblem[];
}

/**
 * Transmitancia por canal: luz que atraviesa el líquido sobre el papel blanco dividida por la del
 * papel sin líquido, en el mismo fotograma (así no importan la exposición ni el balance de blancos).
 */
export function measureTransmittance(
  sampleStatistics: RegionColorStatistics,
  paperStatistics: RegionColorStatistics,
): TransmittanceMeasurement {
  const sampleLinear = sampleStatistics.meanLinear;
  const paperLinear = paperStatistics.meanLinear;
  const problems: ExposureProblem[] = [];
  const brightestPaperChannel = Math.max(paperLinear.red, paperLinear.green, paperLinear.blue);
  const darkestPaperChannel = Math.min(paperLinear.red, paperLinear.green, paperLinear.blue);
  if (brightestPaperChannel > overexposedPaperLinear) problems.push('paper-overexposed');
  if (darkestPaperChannel < underexposedPaperLinear) problems.push('paper-underexposed');

  const channelTransmittance = (channel: CameraChannel) =>
    sampleLinear[channel] / Math.max(paperLinear[channel], 1e-6);
  const transmittance = {
    red: channelTransmittance('red'),
    green: channelTransmittance('green'),
    blue: channelTransmittance('blue'),
  };
  // Un poco de margen: el líquido y el vidrio pueden reflejar algo más de luz que el papel.
  if (Math.max(transmittance.red, transmittance.green, transmittance.blue) > 1.1) {
    problems.push('sample-brighter-than-paper');
  }
  if (Math.max(transmittance.red, transmittance.green, transmittance.blue) < 0.03) problems.push('too-dark');
  return { transmittance, problems };
}

// ── Cerveza: SRM y EBC ──────────────────────────────────────────────────────────────────────

/** SRM máximo que se busca (una stout muy negra ronda 40–70). */
export const maximumSrm = 100;
/** Error medio del ajuste (en décadas de transmitancia) por encima del cual el líquido no se comporta como una cerveza. */
export const poorFitResidual = 0.15;

export interface BeerColorEstimate {
  srm: number;
  ebc: number;
  /** Raíz del error cuadrático medio ponderado del ajuste, en log10 de la transmitancia. */
  fitResidual: number;
  isFitPoor: boolean;
  descriptor: BeerColorDescriptor;
}

function beerFitError(measuredTransmittance: LinearRgb, pathLengthCm: number, candidateSrm: number): number {
  const predictedTransmittance = predictBeerTransmittance(candidateSrm, pathLengthCm);
  let weightedSquaredError = 0;
  let weightSum = 0;
  for (const channel of cameraChannels) {
    const measuredChannel = Math.min(1, Math.max(transmittanceFloor, measuredTransmittance[channel]));
    const predictedChannel = Math.max(transmittanceFloor, predictedTransmittance[channel]);
    // Los canales muy oscuros tienen más ruido relativo: pesan menos.
    const channelWeight = measuredChannel;
    weightedSquaredError += channelWeight * (Math.log10(measuredChannel) - Math.log10(predictedChannel)) ** 2;
    weightSum += channelWeight;
  }
  return weightSum > 0 ? weightedSquaredError / weightSum : Number.POSITIVE_INFINITY;
}

/**
 * Busca el SRM cuyo espectro de deLange, visto por los tres canales, se parece más a la
 * transmitancia medida. Primero una rejilla gruesa y luego una sección áurea alrededor del mínimo.
 */
export function estimateBeerColor(measuredTransmittance: LinearRgb, pathLengthCm: number): BeerColorEstimate {
  const gridStepSrm = 0.5;
  let bestGridSrm = 0;
  let bestGridError = Number.POSITIVE_INFINITY;
  for (let candidateSrm = 0; candidateSrm <= maximumSrm; candidateSrm += gridStepSrm) {
    const candidateError = beerFitError(measuredTransmittance, pathLengthCm, candidateSrm);
    if (candidateError < bestGridError) {
      bestGridError = candidateError;
      bestGridSrm = candidateSrm;
    }
  }

  const goldenRatio = (Math.sqrt(5) - 1) / 2;
  let lowerSrm = Math.max(0, bestGridSrm - gridStepSrm);
  let upperSrm = Math.min(maximumSrm, bestGridSrm + gridStepSrm);
  for (let iteration = 0; iteration < 30; iteration++) {
    const leftProbeSrm = upperSrm - goldenRatio * (upperSrm - lowerSrm);
    const rightProbeSrm = lowerSrm + goldenRatio * (upperSrm - lowerSrm);
    if (
      beerFitError(measuredTransmittance, pathLengthCm, leftProbeSrm) <
      beerFitError(measuredTransmittance, pathLengthCm, rightProbeSrm)
    ) {
      upperSrm = rightProbeSrm;
    } else {
      lowerSrm = leftProbeSrm;
    }
  }
  const srm = (lowerSrm + upperSrm) / 2;
  const fitResidual = Math.sqrt(beerFitError(measuredTransmittance, pathLengthCm, srm));
  return {
    srm,
    ebc: srmToEbc(srm),
    fitResidual,
    isFitPoor: fitResidual > poorFitResidual,
    descriptor: describeBeerColor(srm),
  };
}

export function srmToEbc(srm: number): number {
  return srm * 1.97;
}

export type BeerColorDescriptor =
  | 'pale-straw'
  | 'straw'
  | 'pale-gold'
  | 'deep-gold'
  | 'pale-amber'
  | 'medium-amber'
  | 'deep-amber'
  | 'amber-brown'
  | 'brown'
  | 'ruby-brown'
  | 'deep-brown'
  | 'black';

/** Límite superior (SRM) de cada nombre de color, como en las guías de estilos habituales. */
const beerDescriptorUpperSrm: readonly [BeerColorDescriptor, number][] = [
  ['pale-straw', 3],
  ['straw', 4],
  ['pale-gold', 6],
  ['deep-gold', 9],
  ['pale-amber', 12],
  ['medium-amber', 15],
  ['deep-amber', 18],
  ['amber-brown', 20],
  ['brown', 24],
  ['ruby-brown', 30],
  ['deep-brown', 40],
];

export function describeBeerColor(srm: number): BeerColorDescriptor {
  return beerDescriptorUpperSrm.find(([, upperSrm]) => srm < upperSrm)?.[0] ?? 'black';
}

// ── Vino: intensidad y tonalidad ────────────────────────────────────────────────────────────

export type WineStyle = 'white' | 'rose' | 'red';

export type WineColorDescriptor =
  | 'pale'
  | 'straw'
  | 'golden'
  | 'amber'
  | 'raspberry'
  | 'salmon'
  | 'onion-skin'
  | 'purple'
  | 'ruby'
  | 'garnet'
  | 'tawny';

export interface WineColorEstimate {
  /**
   * Intensidad colorante aproximada (suma de absorbancias por centímetro en los canales azul,
   * verde y rojo, que hacen de 420, 520 y 620 nm en el método de la OIV).
   */
  colorIntensity: number;
  /**
   * Tonalidad aproximada: absorbancia azul / verde (A420/A520 en el método de la OIV). Solo en
   * rosados y tintos, y null si el verde apenas absorbe (el cociente no significaría nada).
   */
  hue: number | null;
  descriptor: WineColorDescriptor;
}

/** Absorbancia verde por centímetro por debajo de la cual la tonalidad no se calcula. */
export const minimumGreenAbsorbanceForHue = 0.05;

/** Absorbancia por centímetro de un canal a partir de su transmitancia. */
function absorbancePerCm(channelTransmittance: number, pathLengthCm: number): number {
  return -Math.log10(Math.min(1, Math.max(transmittanceFloor, channelTransmittance))) / pathLengthCm;
}

export function estimateWineColor(
  measuredTransmittance: LinearRgb,
  pathLengthCm: number,
  wineStyle: WineStyle,
): WineColorEstimate {
  const blueAbsorbance = absorbancePerCm(measuredTransmittance.blue, pathLengthCm);
  const greenAbsorbance = absorbancePerCm(measuredTransmittance.green, pathLengthCm);
  const redAbsorbance = absorbancePerCm(measuredTransmittance.red, pathLengthCm);
  const colorIntensity = blueAbsorbance + greenAbsorbance + redAbsorbance;
  const hue =
    wineStyle !== 'white' && greenAbsorbance >= minimumGreenAbsorbanceForHue ? blueAbsorbance / greenAbsorbance : null;
  return { colorIntensity, hue, descriptor: describeWineColor(wineStyle, blueAbsorbance, hue) };
}

/**
 * Nombre orientativo del color. Los blancos se ordenan por la absorbancia azul (lo amarillo que
 * es); rosados y tintos, por la tonalidad (de violáceo a teja al envejecer).
 */
export function describeWineColor(
  wineStyle: WineStyle,
  blueAbsorbancePerCm: number,
  hue: number | null,
): WineColorDescriptor {
  if (wineStyle === 'white') {
    if (blueAbsorbancePerCm < 0.08) return 'pale';
    if (blueAbsorbancePerCm < 0.2) return 'straw';
    if (blueAbsorbancePerCm < 0.4) return 'golden';
    return 'amber';
  }
  // Sin tonalidad, el verde casi no absorbe: el vino tira a amarillo anaranjado.
  if (hue === null) return wineStyle === 'rose' ? 'onion-skin' : 'tawny';
  if (wineStyle === 'rose') {
    if (hue < 0.8) return 'raspberry';
    if (hue < 1.1) return 'salmon';
    return 'onion-skin';
  }
  if (hue < 0.6) return 'purple';
  if (hue < 0.8) return 'ruby';
  if (hue < 1.0) return 'garnet';
  return 'tawny';
}

// ── Profundidad del líquido ─────────────────────────────────────────────────────────────────

export const minimumPathLengthMm = 0.5;
export const maximumPathLengthMm = 100;

/** Profundidad recomendada: los tintos absorben tanto que con más de un milímetro casi no pasa luz. */
export const recommendedPathLengthMm: Record<'beer' | WineStyle, number> = {
  beer: 10,
  white: 10,
  rose: 10,
  red: 1,
};

/**
 * Camino óptico a partir de la altura del líquido: con el papel iluminado desde arriba, la luz
 * cruza el líquido dos veces (baja hasta el papel y sube hasta la cámara).
 */
export function opticalPathLengthCm(liquidDepthMm: number): number {
  return (2 * liquidDepthMm) / 10;
}

export function isValidPathLengthMm(pathLengthMm: number | null): pathLengthMm is number {
  return (
    pathLengthMm !== null &&
    Number.isFinite(pathLengthMm) &&
    pathLengthMm >= minimumPathLengthMm &&
    pathLengthMm <= maximumPathLengthMm
  );
}
