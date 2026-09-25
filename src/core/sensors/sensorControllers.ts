import { unavailableBecause } from './availabilityRules';
import { locationController } from './adapters/location';
import { microphoneController } from './adapters/microphone';
import {
  accelerometerSource,
  barometerSource,
  gyroscopeSource,
  lightSource,
  magnetometerSource,
} from './adapters/motionAndEnvironment';
import type { SensorAccessController, SensorAvailability, SensorKind } from './types';

function staticController(sensorKind: SensorKind, availability: Omit<SensorAvailability, 'sensorKind'>) {
  const fixedAvailability: SensorAvailability = { sensorKind, ...availability };
  return {
    sensorKind,
    checkAvailability: async () => fixedAvailability,
    requestPermission: async () => fixedAvailability,
  } satisfies SensorAccessController;
}

/**
 * Un controlador por tipo de sensor. Cámara y linterna se conectan en la fase del
 * colorímetro (VisionCamera); hasta entonces se muestran como pendientes.
 */
export const sensorControllers: Record<SensorKind, SensorAccessController> = {
  accelerometer: accelerometerSource,
  gyroscope: gyroscopeSource,
  magnetometer: magnetometerSource,
  barometer: barometerSource,
  light: lightSource,
  location: locationController,
  camera: staticController('camera', unavailableBecause('camera', 'sensors.reason.notYetSupported')),
  microphone: microphoneController,
  torch: staticController('torch', unavailableBecause('torch', 'sensors.reason.notYetSupported')),
  speaker: staticController('speaker', { status: 'available' }),
  vibrator: staticController('vibrator', { status: 'available' }),
};
