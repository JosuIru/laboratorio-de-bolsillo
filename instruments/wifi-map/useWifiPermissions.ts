import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

/** Android 13 (API 33) introdujo NEARBY_WIFI_DEVICES para escanear sin pedir ubicación. */
const nearbyWifiDevicesApiLevel = 33;

const requiresNearbyWifiPermission =
  Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= nearbyWifiDevicesApiLevel;

export interface WifiPermissionState {
  isChecked: boolean;
  /** Ubicación «mientras se usa»: Android la exige para ver el nombre de la red (SSID). */
  hasLocationPermission: boolean;
  areLocationServicesEnabled: boolean;
  /** En Android 13+; en versiones anteriores siempre true (no existe). */
  hasNearbyWifiPermission: boolean;
  /** ¿Se pueden leer las redes vecinas? */
  canScan: boolean;
}

function computeCanScan(state: Omit<WifiPermissionState, 'canScan' | 'isChecked'>): boolean {
  // Android 13+: basta NEARBY_WIFI_DEVICES (declarado con neverForLocation).
  // Antes: hace falta ubicación concedida y activada.
  if (requiresNearbyWifiPermission) return state.hasNearbyWifiPermission;
  return state.hasLocationPermission && state.areLocationServicesEnabled;
}

async function readPermissionState(shouldRequest: boolean): Promise<WifiPermissionState> {
  let hasLocationPermission = false;
  let areLocationServicesEnabled = false;
  try {
    const locationPermission = shouldRequest
      ? await Location.requestForegroundPermissionsAsync()
      : await Location.getForegroundPermissionsAsync();
    hasLocationPermission = locationPermission.status === 'granted';
    areLocationServicesEnabled = await Location.hasServicesEnabledAsync();
  } catch {
    // Sin módulo de ubicación: se sigue sin SSID ni escaneo.
  }

  let hasNearbyWifiPermission = true;
  if (requiresNearbyWifiPermission) {
    const nearbyWifiPermission = PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES;
    try {
      hasNearbyWifiPermission = shouldRequest
        ? (await PermissionsAndroid.request(nearbyWifiPermission)) === PermissionsAndroid.RESULTS.GRANTED
        : await PermissionsAndroid.check(nearbyWifiPermission);
    } catch {
      hasNearbyWifiPermission = false;
    }
  }

  const partialState = { hasLocationPermission, areLocationServicesEnabled, hasNearbyWifiPermission };
  return { ...partialState, isChecked: true, canScan: computeCanScan(partialState) };
}

export function useWifiPermissions() {
  const [permissionState, setPermissionState] = useState<WifiPermissionState>({
    isChecked: false,
    hasLocationPermission: false,
    areLocationServicesEnabled: false,
    hasNearbyWifiPermission: false,
    canScan: false,
  });

  useEffect(() => {
    let isMounted = true;
    void readPermissionState(false).then((initialState) => {
      if (isMounted) setPermissionState(initialState);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  const requestPermissions = useCallback(async () => {
    setPermissionState(await readPermissionState(true));
  }, []);

  return { permissionState, requestPermissions };
}
