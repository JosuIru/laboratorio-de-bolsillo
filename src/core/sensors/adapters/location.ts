import * as Location from 'expo-location';

import { combineHardwareAndPermission, unavailableBecause } from '../availabilityRules';
import type { SensorAccessController, SensorAvailability } from '../types';

export interface GeoLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracyMeters?: number;
}

async function readLocationAvailability(shouldRequestPermission: boolean): Promise<SensorAvailability> {
  try {
    const areServicesEnabled = await Location.hasServicesEnabledAsync();
    if (!areServicesEnabled) return unavailableBecause('location', 'sensors.reason.locationServicesOff');
    const permission = shouldRequestPermission
      ? await Location.requestForegroundPermissionsAsync()
      : await Location.getForegroundPermissionsAsync();
    return combineHardwareAndPermission('location', true, permission);
  } catch {
    return combineHardwareAndPermission('location', false, null);
  }
}

export const locationController: SensorAccessController = {
  sensorKind: 'location',
  checkAvailability: () => readLocationAvailability(false),
  requestPermission: () => readLocationAvailability(true),
};

/**
 * Ubicación para etiquetar una medición. Prioriza la rapidez: usa la última posición conocida
 * si es reciente y, si no, pide una nueva con precisión equilibrada y tiempo límite.
 * Devuelve `undefined` si no hay permiso o no se obtiene a tiempo; nunca lanza.
 */
export async function getLocationForMeasurement(options?: {
  maxAgeMilliseconds?: number;
  timeoutMilliseconds?: number;
}): Promise<GeoLocation | undefined> {
  const maxAgeMilliseconds = options?.maxAgeMilliseconds ?? 60_000;
  const timeoutMilliseconds = options?.timeoutMilliseconds ?? 5_000;
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== 'granted') return undefined;

    const lastKnownPosition = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMilliseconds });
    const position =
      lastKnownPosition ??
      (await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMilliseconds)),
      ]));
    if (!position) return undefined;

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      altitude: position.coords.altitude ?? undefined,
      accuracyMeters: position.coords.accuracy ?? undefined,
    };
  } catch {
    return undefined;
  }
}
