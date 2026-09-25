import type { TrackerGroup } from './trackerGrouping';

export interface FollowingCriteria {
  /** Tiempo mínimo escaneando entre la primera y la última vez que se ha visto (sin contar pausas). */
  minimumFollowingMinutes: number;
  /** Sitios distintos (hace falta la ubicación) que cuentan como «varios sitios». */
  minimumDistinctPlaces: number;
  /** Episodios separados (se fue y volvió) que cuentan como «varios momentos». */
  minimumEpisodes: number;
}

export const defaultFollowingCriteria: FollowingCriteria = {
  minimumFollowingMinutes: 10,
  minimumDistinctPlaces: 2,
  minimumEpisodes: 2,
};

export type FollowingLevel =
  /** Visto poco tiempo, o no es un rastreador dedicado. */
  | 'passing'
  /** Lleva un rato cerca: conviene vigilarlo. */
  | 'watch'
  /** Cumple el criterio: te acompaña en varios sitios o momentos. */
  | 'following';

export interface FollowingAssessment {
  level: FollowingLevel;
  observedMinutes: number;
  distinctPlaceCount: number;
  episodeCount: number;
  /** Cumple tiempo y sitios/momentos, pero está en modo «cerca de su dueño»: probablemente es de alguien que va contigo. */
  isCappedBecauseNearOwner: boolean;
}

/**
 * Heurística «te sigue»: un rastreador dedicado que se ve durante más de X minutos y, además,
 * en varios sitios (si hay ubicación) o en varios momentos separados. Es la misma idea que usan
 * las alertas de iOS, Android y AirGuard, con umbrales ajustables. No es una prueba: un
 * rastreador en la mochila de quien viaja contigo da el mismo patrón.
 */
export function assessFollowing(
  group: TrackerGroup,
  criteria: FollowingCriteria = defaultFollowingCriteria,
): FollowingAssessment {
  // Solo el tiempo con el escaneo encendido: una pausa no demuestra que el rastreador siguiera ahí.
  const observedMinutes = group.observedScanningMilliseconds / 60_000;
  const distinctPlaceCount = group.places.length;
  const episodeCount = group.episodes.length;
  const baseAssessment = { observedMinutes, distinctPlaceCount, episodeCount, isCappedBecauseNearOwner: false };

  if (!group.classification.isDedicatedTracker) return { ...baseAssessment, level: 'passing' };

  const hasBeenAroundLongEnough = observedMinutes >= criteria.minimumFollowingMinutes;
  const isInSeveralPlacesOrMoments =
    distinctPlaceCount >= criteria.minimumDistinctPlaces || episodeCount >= criteria.minimumEpisodes;

  if (hasBeenAroundLongEnough && isInSeveralPlacesOrMoments) {
    if (group.classification.mode === 'near-owner') {
      return { ...baseAssessment, level: 'watch', isCappedBecauseNearOwner: true };
    }
    return { ...baseAssessment, level: 'following' };
  }
  const hasBeenAroundAWhile = observedMinutes >= criteria.minimumFollowingMinutes / 2;
  return { ...baseAssessment, level: hasBeenAroundAWhile || isInSeveralPlacesOrMoments ? 'watch' : 'passing' };
}

const followingLevelRank: Record<FollowingLevel, number> = { passing: 0, watch: 1, following: 2 };

/** Ordena para la lista: primero los que te siguen, luego los más cercanos. */
export function compareGroupsForDisplay(
  firstEntry: { group: TrackerGroup; assessment: FollowingAssessment },
  secondEntry: { group: TrackerGroup; assessment: FollowingAssessment },
): number {
  const levelDifference = followingLevelRank[secondEntry.assessment.level] - followingLevelRank[firstEntry.assessment.level];
  if (levelDifference !== 0) return levelDifference;
  const dedicatedDifference =
    Number(secondEntry.group.classification.isDedicatedTracker) - Number(firstEntry.group.classification.isDedicatedTracker);
  if (dedicatedDifference !== 0) return dedicatedDifference;
  return secondEntry.group.averageRssi - firstEntry.group.averageRssi;
}
