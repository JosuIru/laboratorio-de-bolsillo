import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { getLocationForMeasurement } from '@/core/sensors/adapters/location';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import { assessFollowing, compareGroupsForDisplay, type FollowingAssessment, type FollowingCriteria } from '@/processing/bluetooth/followingHeuristic';
import { smoothRssi, type SmoothedRssi } from '@/processing/bluetooth/proximity';
import {
  countRecentOtherDevices,
  createTrackerSession,
  forgetStaleDevices,
  type GeoPoint,
  ingestAdvertisement,
  linkRotatedAddresses,
  markScanStarted,
  markScanStopped,
  type TrackerGroup,
  type TrackerSession,
} from '@/processing/bluetooth/trackerGrouping';

import { bleScannerModule, type NativePermissionResponse } from '../../modules/ble-scanner';

export type TrackerScanPhase =
  /** iOS, web o un build sin el módulo nativo. */
  | 'unsupported'
  | 'no-bluetooth-hardware'
  | 'checking'
  | 'needs-permission'
  | 'blocked-permission'
  | 'bluetooth-off'
  | 'idle'
  | 'scanning'
  | 'error';

export interface TrackerListEntry {
  /** Copia del grupo en el momento de la instantánea (el original sigue cambiando). */
  group: TrackerGroup;
  assessment: FollowingAssessment;
}

export interface TrackerScanSnapshot {
  /** Copias de los grupos en el momento de la instantánea (los originales siguen cambiando). */
  groups: TrackerGroup[];
  otherDeviceCount: number;
  /** Tiempo total escaneando en esta sesión (suma de los tramos con el escaneo encendido). */
  scanningMilliseconds: number;
  /** Momento de la instantánea: la pantalla lo usa como «ahora» sin leer el reloj al pintar. */
  snapshotTakenMilliseconds: number;
  revision: number;
}

export interface SearchReading {
  groupId: string;
  smoothedRssi: SmoothedRssi | null;
  lastSeenMilliseconds: number | null;
  /** RSSI suavizado de hace unos segundos, para la tendencia «más caliente / más frío». */
  referenceRssiDbm: number | null;
}

/** Android: SCAN_FAILED_SCANNING_TOO_FREQUENTLY (más de 5 arranques en 30 s). */
export const scanTooFrequentlyErrorCode = 6;

const listRefreshIntervalMilliseconds = 1000;
const housekeepingIntervalMilliseconds = 5000;
const locationRefreshIntervalMilliseconds = 30_000;
const otherDevicesWindowMilliseconds = 60_000;
const trendReferenceDelayMilliseconds = 3000;

function copyGroup(group: TrackerGroup): TrackerGroup {
  return {
    ...group,
    addresses: [...group.addresses],
    episodes: group.episodes.map((episode) => ({ ...episode })),
    places: [...group.places],
  };
}

function isPermissionGranted(permissionResponse: NativePermissionResponse): boolean {
  return permissionResponse.status === 'granted';
}

interface ScannerAvailability {
  phase: TrackerScanPhase;
  errorMessage: string | null;
}

/** Estado del escáner sin tocar React: hardware, permiso y Bluetooth encendido. */
async function readScannerAvailability(): Promise<ScannerAvailability> {
  if (!bleScannerModule || Platform.OS !== 'android') return { phase: 'unsupported', errorMessage: null };
  try {
    const permissionResponse = await bleScannerModule.getPermissionsAsync();
    if (!bleScannerModule.isBluetoothLowEnergyAvailable()) return { phase: 'no-bluetooth-hardware', errorMessage: null };
    if (!isPermissionGranted(permissionResponse)) {
      return { phase: permissionResponse.canAskAgain ? 'needs-permission' : 'blocked-permission', errorMessage: null };
    }
    return { phase: bleScannerModule.isBluetoothEnabled() ? 'idle' : 'bluetooth-off', errorMessage: null };
  } catch (availabilityError) {
    return { phase: 'error', errorMessage: String(availabilityError) };
  }
}

/**
 * Escaneo BLE con el módulo nativo `ble-scanner`, agrupamiento de rastreadores y evaluación de
 * «te sigue». La sesión (lo visto hasta ahora) sobrevive a pausas del escaneo: solo se borra
 * con `clearSession`. El escaneo se para al salir de la pantalla o de la app.
 */
export function useTrackerScan(followingCriteria: FollowingCriteria, isLocationEnabled: boolean) {
  const [phase, setPhase] = useState<TrackerScanPhase>(bleScannerModule && Platform.OS === 'android' ? 'checking' : 'unsupported');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scanErrorCode, setScanErrorCode] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<TrackerScanSnapshot>({
    groups: [],
    otherDeviceCount: 0,
    scanningMilliseconds: 0,
    snapshotTakenMilliseconds: 0,
    revision: 0,
  });
  const [searchReading, setSearchReading] = useState<SearchReading | null>(null);
  const [searchedGroupId, setSearchedGroupId] = useState<string | null>(null);

  const sessionRef = useRef<TrackerSession>(createTrackerSession());
  const currentLocationRef = useRef<GeoPoint | null>(null);
  const searchedGroupIdRef = useRef<string | null>(null);
  const searchReadingRef = useRef<SearchReading | null>(null);
  const rssiHistoryRef = useRef<SmoothedRssi[]>([]);
  const scanStartedMillisecondsRef = useRef<number | null>(null);
  const accumulatedScanningMillisecondsRef = useRef(0);
  const revisionRef = useRef(0);
  const stopScanRef = useRef<(() => void) | null>(null);

  const publishSnapshot = useCallback(() => {
    const session = sessionRef.current;
    const nowMilliseconds = Date.now();
    const groups = [...session.groupsById.values()].map(copyGroup);
    const runningMilliseconds =
      scanStartedMillisecondsRef.current === null ? 0 : nowMilliseconds - scanStartedMillisecondsRef.current;
    revisionRef.current += 1;
    setSnapshot({
      groups,
      otherDeviceCount: countRecentOtherDevices(session, nowMilliseconds, otherDevicesWindowMilliseconds),
      scanningMilliseconds: accumulatedScanningMillisecondsRef.current + runningMilliseconds,
      snapshotTakenMilliseconds: nowMilliseconds,
      revision: revisionRef.current,
    });
  }, []);

  // La evaluación «te sigue» se hace al pintar: cambiar el umbral reevalúa la lista al momento.
  const entries = useMemo<TrackerListEntry[]>(
    () =>
      snapshot.groups
        .map((group) => ({ group, assessment: assessFollowing(group, followingCriteria) }))
        .sort(compareGroupsForDisplay),
    [snapshot.groups, followingCriteria],
  );

  /** Empieza (o deja, con `null`) de seguir un grupo en el modo buscar. */
  const selectSearchedGroup = useCallback((groupId: string | null) => {
    searchedGroupIdRef.current = groupId;
    setSearchedGroupId(groupId);
    rssiHistoryRef.current = [];
    const initialReading = groupId
      ? {
          groupId,
          smoothedRssi: null,
          lastSeenMilliseconds: sessionRef.current.groupsById.get(groupId)?.lastSeenMilliseconds ?? null,
          referenceRssiDbm: null,
        }
      : null;
    searchReadingRef.current = initialReading;
    setSearchReading(initialReading);
  }, []);

  const applyAvailability = useCallback((availability: ScannerAvailability) => {
    setErrorMessage(availability.errorMessage);
    setPhase(availability.phase);
  }, []);

  const refreshAvailability = useCallback(async () => {
    applyAvailability(await readScannerAvailability());
  }, [applyAvailability]);

  useEffect(() => {
    let isCancelled = false;
    void readScannerAvailability().then((availability) => {
      if (!isCancelled) applyAvailability(availability);
    });
    return () => {
      isCancelled = true;
    };
  }, [applyAvailability]);

  const requestPermission = useCallback(async () => {
    if (!bleScannerModule) return;
    try {
      const permissionResponse = await bleScannerModule.requestPermissionsAsync();
      if (!isPermissionGranted(permissionResponse)) {
        setPhase(permissionResponse.canAskAgain ? 'needs-permission' : 'blocked-permission');
        return;
      }
      await refreshAvailability();
    } catch (permissionError) {
      setErrorMessage(String(permissionError));
      setPhase('error');
    }
  }, [refreshAvailability]);

  const releaseScan = useCallback(() => {
    const stopScan = stopScanRef.current;
    stopScanRef.current = null;
    stopScan?.();
    if (scanStartedMillisecondsRef.current !== null) {
      const stoppedAtMilliseconds = Date.now();
      accumulatedScanningMillisecondsRef.current += stoppedAtMilliseconds - scanStartedMillisecondsRef.current;
      scanStartedMillisecondsRef.current = null;
      markScanStopped(sessionRef.current, stoppedAtMilliseconds);
    }
  }, []);

  const stop = useCallback(() => {
    releaseScan();
    publishSnapshot();
    setPhase((currentPhase) => (currentPhase === 'scanning' ? 'idle' : currentPhase));
  }, [publishSnapshot, releaseScan]);

  useStopWhenAppInactive(() => setPhase((currentPhase) => (currentPhase === 'scanning' ? 'idle' : currentPhase)), releaseScan);

  const start = useCallback(() => {
    const nativeScanner = bleScannerModule;
    if (!nativeScanner || stopScanRef.current) return;
    setErrorMessage(null);
    setScanErrorCode(null);
    if (!nativeScanner.isBluetoothEnabled()) {
      setPhase('bluetooth-off');
      return;
    }

    const advertisementSubscription = nativeScanner.addListener('onAdvertisementBatch', ({ advertisements }) => {
      const session = sessionRef.current;
      const currentSearchedGroupId = searchedGroupIdRef.current;
      let searchedGroupRssi: { rssi: number; timestampMilliseconds: number } | null = null;
      for (const advertisement of advertisements) {
        const group = ingestAdvertisement(session, advertisement, currentLocationRef.current);
        if (group && group.groupId === currentSearchedGroupId) {
          searchedGroupRssi = { rssi: advertisement.rssi, timestampMilliseconds: advertisement.timestampMilliseconds };
          const previousReading = searchReadingRef.current;
          const smoothedRssi = smoothRssi(previousReading?.smoothedRssi ?? null, advertisement.rssi, advertisement.timestampMilliseconds);
          searchReadingRef.current = {
            groupId: currentSearchedGroupId,
            smoothedRssi,
            lastSeenMilliseconds: advertisement.timestampMilliseconds,
            referenceRssiDbm: previousReading?.referenceRssiDbm ?? null,
          };
        }
      }
      const currentReading = searchReadingRef.current;
      if (searchedGroupRssi && currentReading?.smoothedRssi) {
        // Guarda un historial corto para comparar con el valor de hace unos segundos.
        const rssiHistory = rssiHistoryRef.current;
        rssiHistory.push(currentReading.smoothedRssi);
        const referenceTimestamp = currentReading.smoothedRssi.timestampMilliseconds - trendReferenceDelayMilliseconds;
        while (rssiHistory.length > 1 && (rssiHistory[1]?.timestampMilliseconds ?? Infinity) <= referenceTimestamp) rssiHistory.shift();
        const referenceEntry = rssiHistory[0];
        const referenceRssiDbm =
          referenceEntry && referenceEntry.timestampMilliseconds <= referenceTimestamp ? referenceEntry.valueDbm : null;
        searchReadingRef.current = { ...currentReading, referenceRssiDbm };
        setSearchReading(searchReadingRef.current);
      }
    });
    const scanErrorSubscription = nativeScanner.addListener('onScanError', ({ errorCode }) => {
      releaseScan();
      setScanErrorCode(errorCode);
      setPhase('error');
    });

    const listRefreshInterval = setInterval(publishSnapshot, listRefreshIntervalMilliseconds);
    const housekeepingInterval = setInterval(() => {
      // Si se apaga el Bluetooth, el escáner deja de entregar anuncios sin avisar: se para y se
      // muestra el aviso de Bluetooth apagado en vez de seguir en «Escaneando…».
      let isBluetoothStillEnabled = true;
      try {
        isBluetoothStillEnabled = nativeScanner.isBluetoothEnabled();
      } catch {
        // Si no se puede consultar, se sigue escaneando.
      }
      if (!isBluetoothStillEnabled) {
        releaseScan();
        publishSnapshot();
        setPhase('bluetooth-off');
        return;
      }
      const nowMilliseconds = Date.now();
      const rotationLinks = linkRotatedAddresses(sessionRef.current, nowMilliseconds);
      forgetStaleDevices(sessionRef.current, nowMilliseconds);
      // Si el rastreador que se busca cambió de dirección y se fundió, seguir al grupo superviviente.
      for (const rotationLink of rotationLinks) {
        if (rotationLink.absorbedGroupId === searchedGroupIdRef.current) {
          searchedGroupIdRef.current = rotationLink.survivingGroupId;
          setSearchedGroupId(rotationLink.survivingGroupId);
          if (searchReadingRef.current) {
            searchReadingRef.current = { ...searchReadingRef.current, groupId: rotationLink.survivingGroupId };
            setSearchReading(searchReadingRef.current);
          }
        }
      }
    }, housekeepingIntervalMilliseconds);

    stopScanRef.current = () => {
      clearInterval(listRefreshInterval);
      clearInterval(housekeepingInterval);
      advertisementSubscription.remove();
      scanErrorSubscription.remove();
      try {
        nativeScanner.stopScan();
      } catch {
        // El escaneo ya estaba parado.
      }
    };

    try {
      nativeScanner.startScan();
      scanStartedMillisecondsRef.current = Date.now();
      markScanStarted(sessionRef.current, scanStartedMillisecondsRef.current);
      setPhase('scanning');
    } catch (startError) {
      releaseScan();
      setErrorMessage(String(startError));
      setPhase('error');
    }
  }, [publishSnapshot, releaseScan]);

  // Ubicación opcional: se consulta de vez en cuando para distinguir «sitios distintos».
  useEffect(() => {
    if (!isLocationEnabled || phase !== 'scanning') return;
    let isCancelled = false;
    const refreshLocation = async () => {
      const location = await getLocationForMeasurement({ maxAgeMilliseconds: locationRefreshIntervalMilliseconds });
      if (!isCancelled && location) {
        // La precisión permite descartar posiciones imprecisas al contar sitios distintos.
        currentLocationRef.current = {
          latitude: location.latitude,
          longitude: location.longitude,
          ...(location.accuracyMeters !== undefined ? { accuracyMeters: location.accuracyMeters } : {}),
        };
      }
    };
    void refreshLocation();
    const locationInterval = setInterval(() => void refreshLocation(), locationRefreshIntervalMilliseconds);
    return () => {
      isCancelled = true;
      clearInterval(locationInterval);
    };
  }, [isLocationEnabled, phase]);

  useEffect(() => {
    if (!isLocationEnabled) currentLocationRef.current = null;
  }, [isLocationEnabled]);

  const clearSession = useCallback(() => {
    sessionRef.current = createTrackerSession();
    accumulatedScanningMillisecondsRef.current = 0;
    if (scanStartedMillisecondsRef.current !== null) {
      scanStartedMillisecondsRef.current = Date.now();
      markScanStarted(sessionRef.current, scanStartedMillisecondsRef.current);
    }
    selectSearchedGroup(null);
    publishSnapshot();
  }, [publishSnapshot, selectSearchedGroup]);

  return {
    phase,
    errorMessage,
    scanErrorCode,
    snapshot,
    entries,
    searchedGroupId,
    selectSearchedGroup,
    searchReading,
    start,
    stop,
    requestPermission,
    refreshAvailability,
    clearSession,
  };
}

/** Pide la ubicación en primer plano (solo si el usuario activa la opción). */
export async function requestLocationForPlaces(): Promise<boolean> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    return permission.status === 'granted';
  } catch {
    return false;
  }
}
