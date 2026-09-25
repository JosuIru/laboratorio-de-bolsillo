import type { SensorAvailability, SensorAvailabilityMap, SensorKind } from '@/core/sensors/types';

import type { AnyInstrumentDefinition } from './types';

export type InstrumentReadiness =
  /** Todos los sensores obligatorios disponibles. */
  | { status: 'ready' }
  /** Falta algún permiso que todavía se puede pedir desde la app. */
  | { status: 'needs-permission'; sensorsNeedingPermission: SensorKind[] }
  /** El permiso se denegó de forma permanente: solo se puede conceder en los ajustes del sistema. */
  | { status: 'blocked-permission'; sensorsNeedingPermission: SensorKind[] }
  /** Falta hardware o soporte: el instrumento se muestra deshabilitado. */
  | { status: 'unavailable'; unavailableSensors: SensorAvailability[] };

export function evaluateInstrumentReadiness(
  instrument: Pick<AnyInstrumentDefinition, 'requiredSensors'>,
  availabilityBySensor: SensorAvailabilityMap,
): InstrumentReadiness {
  const requiredAvailability = instrument.requiredSensors.map((sensorKind) => availabilityBySensor[sensorKind]);

  const unavailableSensors = requiredAvailability.filter((availability) => availability.status === 'unavailable');
  if (unavailableSensors.length > 0) return { status: 'unavailable', unavailableSensors };

  const availabilityNeedingPermission = requiredAvailability.filter(
    (availability) => availability.status === 'permission-denied' || availability.status === 'permission-undetermined',
  );
  if (availabilityNeedingPermission.length === 0) return { status: 'ready' };

  const sensorsNeedingPermission = availabilityNeedingPermission.map((availability) => availability.sensorKind);
  const isPermanentlyBlocked = availabilityNeedingPermission.some(
    (availability) => availability.status === 'permission-denied' && availability.canAskAgain === false,
  );
  return isPermanentlyBlocked
    ? { status: 'blocked-permission', sensorsNeedingPermission }
    : { status: 'needs-permission', sensorsNeedingPermission };
}
