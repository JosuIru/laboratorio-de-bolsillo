import { unavailableBecause } from './availabilityRules';
import { cameraController } from './adapters/camera';
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
 * Un controlador por tipo de sensor. La linterna se controla desde la cámara de cada
 * instrumento (depende del dispositivo de cámara elegido), así que aquí queda pendiente.
 */
export const sensorControllers: Record<SensorKind, SensorAccessController> = {
  accelerometer: accelerometerSource,
  gyroscope: gyroscopeSource,
  magnetometer: magnetometerSource,
  barometer: barometerSource,
  light: lightSource,
  location: locationController,
  camera: cameraController,
  microphone: microphoneController,
  torch: staticController('torch', unavailableBecause('torch', 'sensors.reason.notYetSupported')),
  speaker: staticController('speaker', { status: 'available' }),
  vibrator: staticController('vibrator', { status: 'available' }),
};
