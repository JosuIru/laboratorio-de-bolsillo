import { airTagNearOwnerAdvertisement, airTagSeparatedAdvertisement, genericFitnessBandAdvertisement, tileAdvertisement } from './exampleAdvertisements';
import {
  countRecentOtherDevices,
  createTrackerSession,
  distanceBetweenPointsMeters,
  forgetStaleDevices,
  ingestAdvertisement,
  linkRotatedAddresses,
  markScanStarted,
  markScanStopped,
  scannedMillisecondsBetween,
  type TrackerSession,
} from './trackerGrouping';

const seconds = 1000;
const minutes = 60 * seconds;

/** Simula un rastreador que anuncia cada `intervalMilliseconds` entre dos instantes. */
function advertiseRepeatedly(
  session: TrackerSession,
  buildAdvertisementAt: (timestampMilliseconds: number) => Parameters<typeof ingestAdvertisement>[1],
  startMilliseconds: number,
  endMilliseconds: number,
  intervalMilliseconds = 2 * seconds,
) {
  for (let timestampMilliseconds = startMilliseconds; timestampMilliseconds <= endMilliseconds; timestampMilliseconds += intervalMilliseconds) {
    ingestAdvertisement(session, buildAdvertisementAt(timestampMilliseconds));
  }
}

describe('agrupamiento de direcciones', () => {
  it('una misma dirección suma avistamientos en un solo grupo y cuenta aparte lo que no es rastreador', () => {
    const session = createTrackerSession();
    advertiseRepeatedly(session, (timestamp) => tileAdvertisement('T1', -70, timestamp), 0, 10 * seconds);
    ingestAdvertisement(session, { ...genericFitnessBandAdvertisement('BAND'), timestampMilliseconds: 5 * seconds });
    expect(session.groupsById.size).toBe(1);
    const [tileGroup] = session.groupsById.values();
    expect(tileGroup?.sightingCount).toBe(6);
    expect(tileGroup?.averageRssi).toBeCloseTo(-70);
    expect(countRecentOtherDevices(session, 10 * seconds, 30 * seconds)).toBe(1);
  });

  it('enlaza una dirección rotada (misma firma, sin solaparse, hueco corto) cuando la antigua calla', () => {
    const session = createTrackerSession();
    advertiseRepeatedly(session, (timestamp) => airTagNearOwnerAdvertisement('OLD', -65, timestamp), 0, 15 * minutes);
    const rotationMilliseconds = 15 * minutes + 3 * seconds;
    advertiseRepeatedly(session, (timestamp) => airTagNearOwnerAdvertisement('NEW', -67, timestamp), rotationMilliseconds, rotationMilliseconds + 4 * seconds);
    // Aún no: la antigua podría ser otro AirTag que simplemente ha fallado un anuncio.
    expect(linkRotatedAddresses(session, rotationMilliseconds + 4 * seconds)).toHaveLength(0);
    advertiseRepeatedly(session, (timestamp) => airTagNearOwnerAdvertisement('NEW', -67, timestamp), rotationMilliseconds + 6 * seconds, rotationMilliseconds + 20 * seconds);
    expect(linkRotatedAddresses(session, rotationMilliseconds + 20 * seconds)).toEqual([
      { survivingGroupId: 'tracker-1', absorbedGroupId: 'tracker-2' },
    ]);

    expect(session.groupsById.size).toBe(1);
    const [airTagGroup] = session.groupsById.values();
    expect(airTagGroup?.groupId).toBe('tracker-1');
    expect(airTagGroup?.addresses).toEqual(['OLD', 'NEW']);
    expect(airTagGroup?.firstSeenMilliseconds).toBe(0);
    expect(airTagGroup?.lastSeenMilliseconds).toBe(rotationMilliseconds + 20 * seconds);
    expect(airTagGroup?.episodes).toHaveLength(1);
    // Los anuncios posteriores de la dirección nueva siguen yendo al grupo original.
    expect(ingestAdvertisement(session, airTagNearOwnerAdvertisement('NEW', -66, rotationMilliseconds + 22 * seconds))?.groupId).toBe('tracker-1');
  });

  it('un hueco que abarca una pausa del escaneo no abre otro episodio ni suma tiempo observado', () => {
    // Escanea 1 min, el móvil se bloquea 10 min y escanea 30 s más.
    const pausedSession = createTrackerSession();
    markScanStarted(pausedSession, 0);
    advertiseRepeatedly(pausedSession, (timestamp) => airTagSeparatedAdvertisement('PAUSED', -60, timestamp), 0, minutes);
    markScanStopped(pausedSession, minutes);
    markScanStarted(pausedSession, 11 * minutes);
    advertiseRepeatedly(pausedSession, (timestamp) => airTagSeparatedAdvertisement('PAUSED', -60, timestamp), 11 * minutes, 11 * minutes + 30 * seconds);
    const pausedGroup = pausedSession.groupsById.get('tracker-1');
    expect(pausedGroup?.episodes).toHaveLength(1);
    expect(pausedGroup?.observedScanningMilliseconds).toBe(minutes + 30 * seconds);

    const continuousSession = createTrackerSession();
    markScanStarted(continuousSession, 0);
    advertiseRepeatedly(continuousSession, (timestamp) => airTagSeparatedAdvertisement('GONE', -60, timestamp), 0, minutes);
    advertiseRepeatedly(continuousSession, (timestamp) => airTagSeparatedAdvertisement('GONE', -60, timestamp), 5 * minutes + seconds, 6 * minutes);
    expect(continuousSession.groupsById.get('tracker-1')?.episodes).toHaveLength(2);
    expect(continuousSession.groupsById.get('tracker-1')?.observedScanningMilliseconds).toBe(6 * minutes - seconds);
  });

  it('un hueco largo con parte escaneada abre episodio solo si lo escaneado supera el umbral', () => {
    // Visto en el minuto 1; escaneo encendido hasta el 3, parado hasta el 10 y encendido de nuevo.
    const session = createTrackerSession();
    markScanStarted(session, 0);
    ingestAdvertisement(session, tileAdvertisement('T', -60, minutes));
    markScanStopped(session, 3 * minutes);
    markScanStarted(session, 10 * minutes);
    // 2 min escaneados sin verlo antes de la pausa y 1 min después: 3 min, justo el umbral.
    ingestAdvertisement(session, tileAdvertisement('T', -60, 11 * minutes));
    expect(session.groupsById.get('tracker-1')?.episodes).toHaveLength(1);
    // 4 min escaneados sin verlo: ahora sí es «otro momento».
    ingestAdvertisement(session, tileAdvertisement('T', -60, 15 * minutes));
    expect(session.groupsById.get('tracker-1')?.episodes).toHaveLength(2);
    expect(scannedMillisecondsBetween(session, 0, 15 * minutes)).toBe(8 * minutes);
  });

  it('no funde dos rastreadores iguales presentes a la vez', () => {
    const session = createTrackerSession();
    advertiseRepeatedly(session, (timestamp) => airTagSeparatedAdvertisement('FIRST', -60, timestamp), 0, 2 * minutes);
    advertiseRepeatedly(session, (timestamp) => airTagSeparatedAdvertisement('SECOND', -62, timestamp + seconds), 0, 2 * minutes);
    expect(linkRotatedAddresses(session, 2 * minutes + 30 * seconds)).toHaveLength(0);
    expect(session.groupsById.size).toBe(2);
  });

  it('no enlaza firmas distintas, huecos largos ni saltos grandes de RSSI', () => {
    const session = createTrackerSession();
    advertiseRepeatedly(session, (timestamp) => airTagSeparatedAdvertisement('AIRTAG', -60, timestamp), 0, 30 * seconds);
    // Firma distinta (Tile) justo después.
    advertiseRepeatedly(session, (timestamp) => tileAdvertisement('TILE', -60, timestamp), 32 * seconds, 60 * seconds);
    // Misma firma pero dos minutos después (hueco mayor que el máximo).
    advertiseRepeatedly(session, (timestamp) => airTagSeparatedAdvertisement('LATE', -60, timestamp), 3 * minutes, 3 * minutes + 20 * seconds);
    expect(linkRotatedAddresses(session, 4 * minutes)).toHaveLength(0);

    const rssiSession = createTrackerSession();
    advertiseRepeatedly(rssiSession, (timestamp) => airTagSeparatedAdvertisement('NEAR', -45, timestamp), 0, 30 * seconds);
    advertiseRepeatedly(rssiSession, (timestamp) => airTagSeparatedAdvertisement('FAR', -90, timestamp), 33 * seconds, 60 * seconds);
    expect(linkRotatedAddresses(rssiSession, 2 * minutes)).toHaveLength(0);
  });

  it('abre episodios nuevos tras un hueco largo y cuenta sitios distintos', () => {
    const session = createTrackerSession();
    const home = { latitude: 43.2627, longitude: -2.9253 };
    const nearHome = { latitude: 43.2630, longitude: -2.9255 };
    const office = { latitude: 43.2700, longitude: -2.9400 };
    ingestAdvertisement(session, tileAdvertisement('T', -60, 0), home);
    ingestAdvertisement(session, tileAdvertisement('T', -60, 1 * minutes), nearHome);
    ingestAdvertisement(session, tileAdvertisement('T', -60, 20 * minutes), office);
    const [tileGroup] = session.groupsById.values();
    expect(tileGroup?.episodes).toEqual([
      { startMilliseconds: 0, endMilliseconds: 1 * minutes },
      { startMilliseconds: 20 * minutes, endMilliseconds: 20 * minutes },
    ]);
    expect(tileGroup?.places).toHaveLength(2);
  });

  it('no cuenta como sitio distinto una posición imprecisa (salto de wifi a red móvil)', () => {
    const session = createTrackerSession();
    const homeByWifi = { latitude: 43.2627, longitude: -2.9253, accuracyMeters: 20 };
    // Misma casa, pero la red móvil sitúa el móvil a ~1,5 km con 1500 m de incertidumbre.
    const homeByCellNetwork = { latitude: 43.2760, longitude: -2.9253, accuracyMeters: 1500 };
    const office = { latitude: 43.2700, longitude: -2.9400, accuracyMeters: 30 };
    ingestAdvertisement(session, tileAdvertisement('T', -60, 0), homeByWifi);
    ingestAdvertisement(session, tileAdvertisement('T', -60, minutes), homeByCellNetwork);
    expect(session.groupsById.get('tracker-1')?.places).toHaveLength(1);
    ingestAdvertisement(session, tileAdvertisement('T', -60, 2 * minutes), office);
    expect(session.groupsById.get('tracker-1')?.places).toHaveLength(2);
  });

  it('olvida lo que no se oye desde hace mucho', () => {
    const session = createTrackerSession({ forgetAfterMilliseconds: 10 * minutes });
    ingestAdvertisement(session, tileAdvertisement('T', -60, 0));
    ingestAdvertisement(session, { ...genericFitnessBandAdvertisement('BAND'), timestampMilliseconds: 0 });
    forgetStaleDevices(session, 11 * minutes);
    expect(session.groupsById.size).toBe(0);
    expect(session.groupIdByAddress.size).toBe(0);
    expect(session.otherDeviceLastSeenByAddress.size).toBe(0);
  });

  it('olvida los tramos de escaneo viejos pero conserva el último', () => {
    const session = createTrackerSession({ forgetAfterMilliseconds: 10 * minutes });
    markScanStarted(session, 0);
    markScanStopped(session, minutes);
    markScanStarted(session, 2 * minutes);
    markScanStopped(session, 3 * minutes);
    forgetStaleDevices(session, 30 * minutes);
    expect(session.scanIntervals).toEqual([{ startMilliseconds: 2 * minutes, endMilliseconds: 3 * minutes }]);
  });

  it('calcula distancias geográficas razonables', () => {
    // Un grado de latitud son unos 111 km.
    expect(distanceBetweenPointsMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(111_195, -2);
  });
});
