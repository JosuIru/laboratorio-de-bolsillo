import Storage from 'expo-sqlite/kv-store';

import type { TiltAngles } from '@/processing/signal/orientation';

import type { VehicleLayout } from './levelingGeometry';

/** Medidas del vehículo y cero del móvil, para no tener que volver a introducirlos. */
export interface VehicleSettings {
  vehicleLayout: VehicleLayout;
  /** Anchura entre ruedas de un mismo eje (vía), de centro a centro de la huella. */
  trackWidthCentimeters: number;
  /** Distancia entre ejes (batalla), para vehículos de dos ejes. */
  wheelbaseCentimeters: number;
  /** Distancia del eje a la rueda jockey, para caravanas de un eje. */
  jockeyDistanceCentimeters: number;
  /** Lo que mide el móvil cuando el suelo del vehículo está a nivel (método de inversión). */
  zeroOffset: TiltAngles;
}

export const minimumDimensionCentimeters = 50;
export const maximumDimensionCentimeters = 1500;

export const defaultVehicleSettings: VehicleSettings = {
  vehicleLayout: 'fourWheels',
  trackWidthCentimeters: 180,
  wheelbaseCentimeters: 400,
  jockeyDistanceCentimeters: 400,
  zeroOffset: { tiltXDegrees: 0, tiltYDegrees: 0 },
};

/** Un desfase mayor que esto no es del móvil: el cero se midió mal. */
const maximumZeroOffsetDegrees = 10;

const vehicleSettingsStorageKey = 'rvLeveler.settings';

export function isValidDimension(dimensionCentimeters: unknown): dimensionCentimeters is number {
  return (
    typeof dimensionCentimeters === 'number' &&
    Number.isFinite(dimensionCentimeters) &&
    dimensionCentimeters >= minimumDimensionCentimeters &&
    dimensionCentimeters <= maximumDimensionCentimeters
  );
}

export function isValidZeroOffset(candidateOffset: unknown): candidateOffset is TiltAngles {
  const candidate = candidateOffset as Partial<TiltAngles> | null;
  const isValidAngle = (angleDegrees: unknown) =>
    typeof angleDegrees === 'number' && Number.isFinite(angleDegrees) && Math.abs(angleDegrees) <= maximumZeroOffsetDegrees;
  return !!candidate && typeof candidate === 'object' && isValidAngle(candidate.tiltXDegrees) && isValidAngle(candidate.tiltYDegrees);
}

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredVehicleSettings(storedText: string | null): VehicleSettings {
  if (!storedText) return defaultVehicleSettings;
  try {
    const candidate = JSON.parse(storedText) as Partial<Record<keyof VehicleSettings, unknown>> | null;
    if (!candidate || typeof candidate !== 'object') return defaultVehicleSettings;
    return {
      vehicleLayout: candidate.vehicleLayout === 'singleAxle' ? 'singleAxle' : 'fourWheels',
      trackWidthCentimeters: isValidDimension(candidate.trackWidthCentimeters)
        ? candidate.trackWidthCentimeters
        : defaultVehicleSettings.trackWidthCentimeters,
      wheelbaseCentimeters: isValidDimension(candidate.wheelbaseCentimeters)
        ? candidate.wheelbaseCentimeters
        : defaultVehicleSettings.wheelbaseCentimeters,
      jockeyDistanceCentimeters: isValidDimension(candidate.jockeyDistanceCentimeters)
        ? candidate.jockeyDistanceCentimeters
        : defaultVehicleSettings.jockeyDistanceCentimeters,
      zeroOffset: isValidZeroOffset(candidate.zeroOffset)
        ? { tiltXDegrees: candidate.zeroOffset.tiltXDegrees, tiltYDegrees: candidate.zeroOffset.tiltYDegrees }
        : defaultVehicleSettings.zeroOffset,
    };
  } catch {
    return defaultVehicleSettings;
  }
}

export function loadVehicleSettings(): VehicleSettings {
  try {
    return parseStoredVehicleSettings(Storage.getItemSync(vehicleSettingsStorageKey));
  } catch {
    return defaultVehicleSettings;
  }
}

export function saveVehicleSettings(vehicleSettings: VehicleSettings): void {
  try {
    Storage.setItemSync(vehicleSettingsStorageKey, JSON.stringify(vehicleSettings));
  } catch {
    // Si no se puede guardar, el nivel funciona igual; solo no recordará las medidas ni el cero.
  }
}
