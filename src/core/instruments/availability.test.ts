import {
  allSensorKinds,
  type SensorAvailability,
  type SensorAvailabilityMap,
  type SensorKind,
} from '@/core/sensors/types';

import { evaluateInstrumentReadiness } from './availability';

function buildAvailabilityMap(overrides: Partial<Record<SensorKind, Partial<SensorAvailability>>>) {
  return Object.fromEntries(
    allSensorKinds.map((sensorKind) => [
      sensorKind,
      { sensorKind, status: 'available', ...overrides[sensorKind] } satisfies SensorAvailability,
    ]),
  ) as SensorAvailabilityMap;
}

describe('evaluateInstrumentReadiness', () => {
  const cameraInstrument = { requiredSensors: ['camera', 'light'] as SensorKind[] };

  it('está listo si todos los sensores obligatorios están disponibles', () => {
    const availabilityBySensor = buildAvailabilityMap({ barometer: { status: 'unavailable' } });
    expect(evaluateInstrumentReadiness(cameraInstrument, availabilityBySensor)).toEqual({ status: 'ready' });
  });

  it('prioriza la falta de hardware sobre los permisos', () => {
    const availabilityBySensor = buildAvailabilityMap({
      camera: { status: 'permission-undetermined' },
      light: { status: 'unavailable', reasonKey: 'sensors.reason.missingHardware' },
    });
    const readiness = evaluateInstrumentReadiness(cameraInstrument, availabilityBySensor);
    expect(readiness.status).toBe('unavailable');
    expect(readiness.status === 'unavailable' && readiness.unavailableSensors.map((sensor) => sensor.sensorKind)).toEqual([
      'light',
    ]);
  });

  it('pide permiso si todavía se puede preguntar', () => {
    const availabilityBySensor = buildAvailabilityMap({
      camera: { status: 'permission-denied', canAskAgain: true },
    });
    expect(evaluateInstrumentReadiness(cameraInstrument, availabilityBySensor)).toEqual({
      status: 'needs-permission',
      sensorsNeedingPermission: ['camera'],
    });
  });

  it('marca el permiso como bloqueado si el sistema ya no deja preguntar', () => {
    const availabilityBySensor = buildAvailabilityMap({
      camera: { status: 'permission-denied', canAskAgain: false },
    });
    expect(evaluateInstrumentReadiness(cameraInstrument, availabilityBySensor).status).toBe('blocked-permission');
  });
});
