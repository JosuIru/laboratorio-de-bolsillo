import { airTagNearOwnerAdvertisement, airTagSeparatedAdvertisement, iPhoneFindMyAdvertisement, tileAdvertisement } from './exampleAdvertisements';
import { assessFollowing, compareGroupsForDisplay } from './followingHeuristic';
import { createTrackerSession, ingestAdvertisement, type TrackerGroup } from './trackerGrouping';

const minutes = 60_000;

function groupFromSightings(
  buildAdvertisementAt: (timestampMilliseconds: number) => Parameters<typeof ingestAdvertisement>[1],
  sightingMinutes: number[],
  sightingLocations: ({ latitude: number; longitude: number } | null)[] = [],
): TrackerGroup {
  const session = createTrackerSession();
  let lastGroup: TrackerGroup | null = null;
  sightingMinutes.forEach((sightingMinute, sightingIndex) => {
    lastGroup = ingestAdvertisement(session, buildAdvertisementAt(sightingMinute * minutes), sightingLocations[sightingIndex] ?? null);
  });
  if (!lastGroup) throw new Error('sin grupo');
  return lastGroup;
}

describe('heurística «te sigue»', () => {
  it('un rastreador visto de pasada no preocupa', () => {
    const group = groupFromSightings((timestamp) => airTagSeparatedAdvertisement('A', -70, timestamp), [0, 1, 2]);
    expect(assessFollowing(group).level).toBe('passing');
  });

  it('visto más de X minutos en dos momentos separados: te sigue', () => {
    // Del minuto 0 al 4, desaparece, y vuelve del 12 al 14.
    const group = groupFromSightings((timestamp) => airTagSeparatedAdvertisement('A', -70, timestamp), [0, 2, 4, 12, 13, 14]);
    const assessment = assessFollowing(group, { minimumFollowingMinutes: 10, minimumDistinctPlaces: 2, minimumEpisodes: 2 });
    expect(assessment).toMatchObject({ level: 'following', episodeCount: 2 });
    expect(assessment.observedMinutes).toBeCloseTo(14);
  });

  it('visto más de X minutos en varios sitios (con ubicación), aunque sea sin interrupción', () => {
    const sightingMinutes = Array.from({ length: 13 }, (_, minuteIndex) => minuteIndex);
    // Caminando: 150 m por minuto hacia el norte.
    const sightingLocations = sightingMinutes.map((sightingMinute) => ({ latitude: 43.26 + sightingMinute * 0.00135, longitude: -2.93 }));
    const group = groupFromSightings((timestamp) => tileAdvertisement('T', -70, timestamp), sightingMinutes, sightingLocations);
    expect(group.episodes).toHaveLength(1);
    expect(assessFollowing(group)).toMatchObject({ level: 'following' });
  });

  it('mucho tiempo en un solo sitio y un solo momento: solo vigilar (puede ser del vecino)', () => {
    const sightingMinutes = Array.from({ length: 31 }, (_, minuteIndex) => minuteIndex);
    const group = groupFromSightings((timestamp) => tileAdvertisement('T', -70, timestamp), sightingMinutes);
    expect(assessFollowing(group).level).toBe('watch');
  });

  it('en modo «cerca de su dueño» se queda en vigilar aunque cumpla el criterio', () => {
    const group = groupFromSightings((timestamp) => airTagNearOwnerAdvertisement('A', -70, timestamp), [0, 2, 4, 12, 13, 14]);
    expect(assessFollowing(group)).toMatchObject({ level: 'watch', isCappedBecauseNearOwner: true });
  });

  it('un iPhone de la red Find My no es un rastreador oculto', () => {
    const session = createTrackerSession();
    for (const sightingMinute of [0, 5, 20, 30]) {
      ingestAdvertisement(session, { ...iPhoneFindMyAdvertisement('P'), timestampMilliseconds: sightingMinute * minutes });
    }
    const [iPhoneGroup] = session.groupsById.values();
    if (!iPhoneGroup) throw new Error('sin grupo');
    expect(assessFollowing(iPhoneGroup).level).toBe('passing');
  });

  it('ordena primero los que te siguen y luego por cercanía', () => {
    const followingGroup = groupFromSightings((timestamp) => airTagSeparatedAdvertisement('A', -85, timestamp), [0, 2, 4, 12, 13, 14]);
    const nearbyGroup = groupFromSightings((timestamp) => tileAdvertisement('T', -50, timestamp), [0]);
    const farGroup = groupFromSightings((timestamp) => tileAdvertisement('U', -90, timestamp), [0]);
    const entries = [farGroup, nearbyGroup, followingGroup].map((group) => ({ group, assessment: assessFollowing(group) }));
    expect(entries.sort(compareGroupsForDisplay).map((entry) => entry.group.addresses[0])).toEqual(['A', 'T', 'U']);
  });
});
