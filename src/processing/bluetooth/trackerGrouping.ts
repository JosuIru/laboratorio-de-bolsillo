import type { BleAdvertisement } from './advertisement';
import { classifyAdvertisement, type TrackerClassification } from './trackerSignatures';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Tramo de presencia continua: el rastreador se vio sin huecos mayores que `episodeGapMilliseconds`. */
export interface SightingEpisode {
  startMilliseconds: number;
  endMilliseconds: number;
}

/**
 * Un rastreador «lógico»: una o varias direcciones BLE que, por firma y continuidad, parecen
 * el mismo aparato (los rastreadores cambian de dirección cada cierto tiempo por privacidad).
 */
export interface TrackerGroup {
  groupId: string;
  signatureKey: string;
  classification: TrackerClassification;
  /** Direcciones en orden de aparición; la última es la actual. */
  addresses: string[];
  firstSeenMilliseconds: number;
  /** Primera vez que se vio la dirección actual (para enlazar rotaciones sin solaparse). */
  currentAddressFirstSeenMilliseconds: number;
  lastSeenMilliseconds: number;
  lastRssi: number;
  /** RSSI suavizado con media exponencial para la lista (no para el modo buscar). */
  averageRssi: number;
  sightingCount: number;
  episodes: SightingEpisode[];
  /** Sitios distintos (separados más de `distinctPlaceRadiusMeters`) donde se ha visto. */
  places: GeoPoint[];
}

export interface TrackerGroupingOptions {
  /** Hueco máximo entre la última vez que se oyó una dirección y la primera de la siguiente. */
  rotationMaximumGapMilliseconds: number;
  /**
   * Tiempo que la dirección antigua tiene que seguir callada tras aparecer la nueva para dar la
   * rotación por buena. Evita fundir dos rastreadores iguales que están a la vez.
   */
  rotationConfirmationMilliseconds: number;
  /** Diferencia máxima de RSSI medio entre la dirección antigua y la nueva. */
  rotationMaximumRssiDifference: number;
  /** Un hueco mayor que esto sin verlo abre un episodio nuevo («otro momento»). */
  episodeGapMilliseconds: number;
  distinctPlaceRadiusMeters: number;
  /** Los grupos que no se ven desde hace más de esto se olvidan. */
  forgetAfterMilliseconds: number;
}

export const defaultTrackerGroupingOptions: TrackerGroupingOptions = {
  rotationMaximumGapMilliseconds: 60_000,
  rotationConfirmationMilliseconds: 10_000,
  rotationMaximumRssiDifference: 15,
  episodeGapMilliseconds: 3 * 60_000,
  distinctPlaceRadiusMeters: 200,
  forgetAfterMilliseconds: 2 * 60 * 60_000,
};

export interface TrackerSession {
  groupsById: Map<string, TrackerGroup>;
  groupIdByAddress: Map<string, string>;
  /** Direcciones que no son rastreadores, solo para contarlas. */
  otherDeviceLastSeenByAddress: Map<string, number>;
  nextGroupNumber: number;
  options: TrackerGroupingOptions;
  /**
   * Cuándo se reanudó el escaneo por última vez (tiempo Unix, ms), o `null` si no se ha pausado.
   * Un hueco que abarca una pausa no es «otro momento»: el escáner estaba apagado.
   */
  scanResumedAtMilliseconds: number | null;
}

/** Anota que el escaneo vuelve a empezar tras una pausa (Parar o app en segundo plano). */
export function markScanResumed(session: TrackerSession, resumedAtMilliseconds: number) {
  session.scanResumedAtMilliseconds = resumedAtMilliseconds;
}

export function createTrackerSession(options: Partial<TrackerGroupingOptions> = {}): TrackerSession {
  return {
    groupsById: new Map(),
    groupIdByAddress: new Map(),
    otherDeviceLastSeenByAddress: new Map(),
    nextGroupNumber: 1,
    options: { ...defaultTrackerGroupingOptions, ...options },
    scanResumedAtMilliseconds: null,
  };
}

const averageRssiWeight = 0.3;
const earthRadiusMeters = 6_371_000;

export function distanceBetweenPointsMeters(firstPoint: GeoPoint, secondPoint: GeoPoint): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(secondPoint.latitude - firstPoint.latitude);
  const longitudeDelta = toRadians(secondPoint.longitude - firstPoint.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(firstPoint.latitude)) * Math.cos(toRadians(secondPoint.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function recordPlace(group: TrackerGroup, location: GeoPoint | null, radiusMeters: number) {
  if (!location) return;
  const isNewPlace = group.places.every((knownPlace) => distanceBetweenPointsMeters(knownPlace, location) > radiusMeters);
  if (isNewPlace) group.places.push({ latitude: location.latitude, longitude: location.longitude });
}

function recordSighting(
  group: TrackerGroup,
  timestampMilliseconds: number,
  episodeGapMilliseconds: number,
  scanResumedAtMilliseconds: number | null = null,
) {
  const lastEpisode = group.episodes[group.episodes.length - 1];
  const gapSpansScanPause =
    lastEpisode !== undefined &&
    scanResumedAtMilliseconds !== null &&
    lastEpisode.endMilliseconds < scanResumedAtMilliseconds &&
    timestampMilliseconds - scanResumedAtMilliseconds <= episodeGapMilliseconds;
  if (lastEpisode && (gapSpansScanPause || timestampMilliseconds - lastEpisode.endMilliseconds <= episodeGapMilliseconds)) {
    lastEpisode.endMilliseconds = Math.max(lastEpisode.endMilliseconds, timestampMilliseconds);
  } else {
    group.episodes.push({ startMilliseconds: timestampMilliseconds, endMilliseconds: timestampMilliseconds });
  }
}

/**
 * Incorpora un anuncio a la sesión. Devuelve el grupo al que pertenece, o `null` si no es un
 * rastreador conocido. `location` es la posición del móvil en ese momento, si se conoce.
 */
export function ingestAdvertisement(
  session: TrackerSession,
  advertisement: BleAdvertisement,
  location: GeoPoint | null = null,
): TrackerGroup | null {
  const classification = classifyAdvertisement(advertisement);
  if (!classification) {
    session.otherDeviceLastSeenByAddress.set(advertisement.address, advertisement.timestampMilliseconds);
    return null;
  }
  const { options } = session;
  const timestampMilliseconds = advertisement.timestampMilliseconds;
  const existingGroupId = session.groupIdByAddress.get(advertisement.address);
  const existingGroup = existingGroupId ? session.groupsById.get(existingGroupId) : undefined;

  if (existingGroup) {
    recordSighting(existingGroup, timestampMilliseconds, options.episodeGapMilliseconds, session.scanResumedAtMilliseconds);
    existingGroup.lastSeenMilliseconds = Math.max(existingGroup.lastSeenMilliseconds, timestampMilliseconds);
    existingGroup.lastRssi = advertisement.rssi;
    existingGroup.averageRssi += averageRssiWeight * (advertisement.rssi - existingGroup.averageRssi);
    existingGroup.sightingCount += 1;
    existingGroup.classification = classification;
    recordPlace(existingGroup, location, options.distinctPlaceRadiusMeters);
    return existingGroup;
  }

  const newGroup: TrackerGroup = {
    groupId: `tracker-${session.nextGroupNumber}`,
    signatureKey: classification.signatureKey,
    classification,
    addresses: [advertisement.address],
    firstSeenMilliseconds: timestampMilliseconds,
    currentAddressFirstSeenMilliseconds: timestampMilliseconds,
    lastSeenMilliseconds: timestampMilliseconds,
    lastRssi: advertisement.rssi,
    averageRssi: advertisement.rssi,
    sightingCount: 1,
    episodes: [{ startMilliseconds: timestampMilliseconds, endMilliseconds: timestampMilliseconds }],
    places: [],
  };
  recordPlace(newGroup, location, options.distinctPlaceRadiusMeters);
  session.nextGroupNumber += 1;
  session.groupsById.set(newGroup.groupId, newGroup);
  session.groupIdByAddress.set(advertisement.address, newGroup.groupId);
  return newGroup;
}

export interface RotationLink {
  survivingGroupId: string;
  absorbedGroupId: string;
}

/** Funde el grupo nuevo (dirección rotada) en el antiguo, que conserva su identificador. */
function mergeRotatedGroup(session: TrackerSession, olderGroup: TrackerGroup, newerGroup: TrackerGroup) {
  for (const address of newerGroup.addresses) {
    olderGroup.addresses.push(address);
    session.groupIdByAddress.set(address, olderGroup.groupId);
  }
  for (const newerEpisode of newerGroup.episodes) {
    recordSighting(olderGroup, newerEpisode.startMilliseconds, session.options.episodeGapMilliseconds);
    recordSighting(olderGroup, newerEpisode.endMilliseconds, session.options.episodeGapMilliseconds);
  }
  for (const newerPlace of newerGroup.places) recordPlace(olderGroup, newerPlace, session.options.distinctPlaceRadiusMeters);
  olderGroup.currentAddressFirstSeenMilliseconds = newerGroup.currentAddressFirstSeenMilliseconds;
  olderGroup.lastSeenMilliseconds = newerGroup.lastSeenMilliseconds;
  olderGroup.lastRssi = newerGroup.lastRssi;
  olderGroup.averageRssi = newerGroup.averageRssi;
  olderGroup.sightingCount += newerGroup.sightingCount;
  olderGroup.classification = newerGroup.classification;
  session.groupsById.delete(newerGroup.groupId);
}

/**
 * Enlaza direcciones rotativas. Una dirección nueva B continúa a una antigua A si:
 * tienen la misma firma; A dejó de oírse antes de que apareciera B (no se solapan, así que no
 * pueden ser dos aparatos a la vez); el hueco es corto; A lleva callada al menos
 * `rotationConfirmationMilliseconds` mientras B sigue sonando; y su RSSI medio es parecido.
 * Si hay varias candidatas, gana la de hueco más corto. Devuelve las fusiones hechas (el grupo
 * antiguo conserva su identificador; el nuevo desaparece).
 */
export function linkRotatedAddresses(session: TrackerSession, nowMilliseconds: number): RotationLink[] {
  const { options } = session;
  const groupsByAge = [...session.groupsById.values()].sort(
    (firstGroup, secondGroup) => firstGroup.currentAddressFirstSeenMilliseconds - secondGroup.currentAddressFirstSeenMilliseconds,
  );
  const rotationLinks: RotationLink[] = [];
  const absorbedGroupIds = new Set<string>();

  for (const newerGroup of groupsByAge) {
    if (absorbedGroupIds.has(newerGroup.groupId) || newerGroup.sightingCount < 2) continue;
    let bestOlderGroup: TrackerGroup | null = null;
    let bestGapMilliseconds = Infinity;
    for (const olderGroup of groupsByAge) {
      if (olderGroup === newerGroup || absorbedGroupIds.has(olderGroup.groupId)) continue;
      if (olderGroup.signatureKey !== newerGroup.signatureKey) continue;
      const gapMilliseconds = newerGroup.currentAddressFirstSeenMilliseconds - olderGroup.lastSeenMilliseconds;
      if (gapMilliseconds <= 0 || gapMilliseconds > options.rotationMaximumGapMilliseconds) continue;
      if (nowMilliseconds - olderGroup.lastSeenMilliseconds < options.rotationConfirmationMilliseconds) continue;
      if (Math.abs(olderGroup.averageRssi - newerGroup.averageRssi) > options.rotationMaximumRssiDifference) continue;
      if (gapMilliseconds < bestGapMilliseconds) {
        bestGapMilliseconds = gapMilliseconds;
        bestOlderGroup = olderGroup;
      }
    }
    if (bestOlderGroup) {
      mergeRotatedGroup(session, bestOlderGroup, newerGroup);
      absorbedGroupIds.add(newerGroup.groupId);
      rotationLinks.push({ survivingGroupId: bestOlderGroup.groupId, absorbedGroupId: newerGroup.groupId });
    }
  }
  return rotationLinks;
}

/** Olvida grupos y dispositivos que no se oyen desde hace mucho, para acotar la memoria. */
export function forgetStaleDevices(session: TrackerSession, nowMilliseconds: number) {
  const forgetBeforeMilliseconds = nowMilliseconds - session.options.forgetAfterMilliseconds;
  for (const group of [...session.groupsById.values()]) {
    if (group.lastSeenMilliseconds >= forgetBeforeMilliseconds) continue;
    session.groupsById.delete(group.groupId);
    for (const address of group.addresses) session.groupIdByAddress.delete(address);
  }
  for (const [address, lastSeenMilliseconds] of [...session.otherDeviceLastSeenByAddress]) {
    if (lastSeenMilliseconds < forgetBeforeMilliseconds) session.otherDeviceLastSeenByAddress.delete(address);
  }
}

/** Cuántas direcciones que no son rastreadores se han oído en la última ventana. */
export function countRecentOtherDevices(session: TrackerSession, nowMilliseconds: number, windowMilliseconds: number): number {
  let recentDeviceCount = 0;
  for (const lastSeenMilliseconds of session.otherDeviceLastSeenByAddress.values()) {
    if (nowMilliseconds - lastSeenMilliseconds <= windowMilliseconds) recentDeviceCount += 1;
  }
  return recentDeviceCount;
}
