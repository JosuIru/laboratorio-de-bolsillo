import {
  type CarrierBandId,
  carrierBandDisplayOrder,
  type ConstellationId,
  constellationDisplayOrder,
  isLowerBand,
} from './constellations';
import type { SatelliteObservation } from './types';

/** Por debajo de esto el satélite está «previsto» (almanaque) pero no se recibe de verdad. */
export const minimumTrackedCarrierToNoiseDbHz = 1;

export interface GroupCount<TGroupId> {
  groupId: TGroupId;
  /** Señales recibidas (C/N0 > 0). */
  trackedCount: number;
  /** Señales usadas en la posición. */
  usedInFixCount: number;
}

export interface SkySummary {
  /** Señales listadas por el chip, se reciban o no. */
  listedSignalCount: number;
  trackedSignalCount: number;
  usedInFixSignalCount: number;
  /** Satélites distintos recibidos (un satélite en L1 y L5 cuenta una vez). */
  trackedSatelliteCount: number;
  countsByConstellation: GroupCount<ConstellationId>[];
  countsByBand: GroupCount<CarrierBandId>[];
  /** Hay señales recibidas en la familia L1 y también en L5 (u otra banda baja). */
  isDualFrequency: boolean;
  /** Satélites recibidos a la vez en dos bandas. */
  dualFrequencySatelliteCount: number;
  /** Media de las 4 señales más fuertes (dB-Hz): el indicador habitual de calidad de cielo. */
  topFourMeanCarrierToNoiseDbHz: number | null;
  medianCarrierToNoiseDbHz: number | null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sortedValues = [...values].sort((first, second) => first - second);
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1
    ? (sortedValues[middleIndex] as number)
    : ((sortedValues[middleIndex - 1] as number) + (sortedValues[middleIndex] as number)) / 2;
}

export function isTracked(observation: SatelliteObservation): boolean {
  return observation.carrierToNoiseDensityDbHz >= minimumTrackedCarrierToNoiseDbHz;
}

function countGroups<TGroupId>(
  observations: readonly SatelliteObservation[],
  displayOrder: readonly TGroupId[],
  readGroupId: (observation: SatelliteObservation) => TGroupId,
): GroupCount<TGroupId>[] {
  const countByGroup = new Map<TGroupId, GroupCount<TGroupId>>();
  for (const observation of observations) {
    if (!isTracked(observation)) continue;
    const groupId = readGroupId(observation);
    const groupCount = countByGroup.get(groupId) ?? { groupId, trackedCount: 0, usedInFixCount: 0 };
    groupCount.trackedCount += 1;
    if (observation.isUsedInFix) groupCount.usedInFixCount += 1;
    countByGroup.set(groupId, groupCount);
  }
  return displayOrder.flatMap((groupId) => {
    const groupCount = countByGroup.get(groupId);
    return groupCount ? [groupCount] : [];
  });
}

export function summarizeSky(observations: readonly SatelliteObservation[]): SkySummary {
  const trackedObservations = observations.filter(isTracked);
  const bandsBySatellite = new Map<string, Set<CarrierBandId>>();
  for (const observation of trackedObservations) {
    const satelliteKey = `${observation.constellationId}-${observation.svid}`;
    const satelliteBands = bandsBySatellite.get(satelliteKey) ?? new Set<CarrierBandId>();
    satelliteBands.add(observation.bandId);
    bandsBySatellite.set(satelliteKey, satelliteBands);
  }

  const hasUpperBand = trackedObservations.some(
    (observation) => !isLowerBand(observation.bandId) && observation.bandId !== 'unknown',
  );
  const hasLowerBand = trackedObservations.some((observation) => isLowerBand(observation.bandId));

  const carrierToNoiseValues = trackedObservations.map((observation) => observation.carrierToNoiseDensityDbHz);
  const strongestFourValues = [...carrierToNoiseValues].sort((first, second) => second - first).slice(0, 4);

  return {
    listedSignalCount: observations.length,
    trackedSignalCount: trackedObservations.length,
    usedInFixSignalCount: trackedObservations.filter((observation) => observation.isUsedInFix).length,
    trackedSatelliteCount: bandsBySatellite.size,
    countsByConstellation: countGroups(trackedObservations, constellationDisplayOrder, (observation) => observation.constellationId),
    countsByBand: countGroups(trackedObservations, carrierBandDisplayOrder, (observation) => observation.bandId),
    isDualFrequency: hasUpperBand && hasLowerBand,
    dualFrequencySatelliteCount: [...bandsBySatellite.values()].filter((satelliteBands) => satelliteBands.size >= 2).length,
    topFourMeanCarrierToNoiseDbHz:
      strongestFourValues.length > 0
        ? strongestFourValues.reduce((sum, value) => sum + value, 0) / strongestFourValues.length
        : null,
    medianCarrierToNoiseDbHz: median(carrierToNoiseValues),
  };
}

/** Señales recibidas ordenadas para las barras: por constelación, luego por svid y banda. */
export function sortForCarrierToNoiseBars(observations: readonly SatelliteObservation[]): SatelliteObservation[] {
  const constellationRank = new Map(constellationDisplayOrder.map((constellationId, rank) => [constellationId, rank]));
  const bandRank = new Map(carrierBandDisplayOrder.map((bandId, rank) => [bandId, rank]));
  return observations
    .filter(isTracked)
    .sort(
      (first, second) =>
        (constellationRank.get(first.constellationId) ?? 99) - (constellationRank.get(second.constellationId) ?? 99) ||
        first.svid - second.svid ||
        (bandRank.get(first.bandId) ?? 99) - (bandRank.get(second.bandId) ?? 99),
    );
}
