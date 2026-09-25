import type { TFunction } from 'i18next';

import type { SensorAvailability, SensorKind } from '@/core/sensors/types';

export function sensorDisplayName(t: TFunction, sensorKind: SensorKind): string {
  return t(`core:sensors.name.${sensorKind}`);
}

export function sensorListDisplayText(t: TFunction, sensorKinds: readonly SensorKind[]): string {
  return sensorKinds.map((sensorKind) => sensorDisplayName(t, sensorKind)).join(', ');
}

/** Explicación para el usuario de por qué un sensor no se puede usar. */
export function describeSensorAvailability(t: TFunction, availability: SensorAvailability): string {
  if (availability.reasonKey) {
    return t(`core:${availability.reasonKey}`, { sensor: sensorDisplayName(t, availability.sensorKind) });
  }
  return t(`core:sensors.status.${availability.status}`);
}
