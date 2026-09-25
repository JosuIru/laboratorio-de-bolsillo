import { unavailableBecause } from './availabilityRules';
import { locationController } from './adapters/location';
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
 * Un controlador por tipo de sensor. Cámara, micrófono y linterna se conectan en las fases
 * de sus instrumentos (VisionCamera y react-native-audio-api); hasta entonces se muestran
 * como pendientes.
 */
export const sensorControllers: Record<SensorKind, SensorAccessController> = {
  accelerometer: accelerometerSource,
  gyroscope: gyroscopeSource,
  magnetometer: magnetometerSource,
  barometer: barometerSource,
  light: lightSource,
  location: locationController,
  camera: staticController('camera', unavailableBecause('camera', 'sensors.reason.notYetSupported')),
  microphone: staticController('microphone', unavailableBecause('microphone', 'sensors.reason.notYetSupported')),
  torch: staticController('torch', unavailableBecause('torch', 'sensors.reason.notYetSupported')),
  speaker: staticController('speaker', { status: 'available' }),
  vibrator: staticController('vibrator', { status: 'available' }),
};
