import type { SensorAvailability, SensorKind } from './types';

/** Forma mínima de la respuesta de permisos de los módulos de Expo. */
export interface PermissionSnapshot {
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
}

export function combineHardwareAndPermission(
  sensorKind: SensorKind,
  isHardwarePresent: boolean,
  permission: PermissionSnapshot | null,
): SensorAvailability {
  if (!isHardwarePresent) {
    return { sensorKind, status: 'unavailable', reasonKey: 'sensors.reason.missingHardware' };
  }
  if (permission === null || permission.status === 'granted') {
    return { sensorKind, status: 'available' };
  }
  if (permission.status === 'denied') {
    return {
      sensorKind,
      status: 'permission-denied',
      canAskAgain: permission.canAskAgain,
      reasonKey: permission.canAskAgain ? 'sensors.reason.permissionDenied' : 'sensors.reason.permissionBlocked',
    };
  }
  return {
    sensorKind,
    status: 'permission-undetermined',
    canAskAgain: true,
    reasonKey: 'sensors.reason.permissionUndetermined',
  };
}

export function unavailableBecause(sensorKind: SensorKind, reasonKey: string): SensorAvailability {
  return { sensorKind, status: 'unavailable', reasonKey };
}

/** Pasa de la frecuencia deseada al intervalo en milisegundos que piden los módulos de Expo. */
export function updateIntervalMsForRate(targetRateHz: number | undefined, defaultRateHz: number): number {
  const effectiveRateHz = targetRateHz && targetRateHz > 0 ? targetRateHz : defaultRateHz;
  return Math.max(1, Math.round(1000 / effectiveRateHz));
}
