import { Platform } from 'react-native';

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
 * Bluetooth, Wi‑Fi y GNSS en crudo se leen con módulos nativos propios que solo existen en
 * Android. Los permisos (dispositivos cercanos, ubicación) los pide la pantalla de cada
 * instrumento, porque dependen de la versión de Android y de lo que vaya a leer.
 */
function androidOnlyController(sensorKind: SensorKind) {
  return staticController(
    sensorKind,
    Platform.OS === 'android' ? { status: 'available' } : unavailableBecause(sensorKind, 'sensors.reason.androidOnly'),
  );
}

/**
 * La linterna se enciende desde la cámara de cada instrumento, con su mismo permiso: está
 * disponible si la cámara lo está. Si el móvil no tiene flash, lo avisa el propio instrumento
 * (depende de la cámara elegida).
 */
const torchController = {
  sensorKind: 'torch',
  checkAvailability: async () => ({ ...(await cameraController.checkAvailability()), sensorKind: 'torch' }),
  requestPermission: async () => ({ ...(await cameraController.requestPermission()), sensorKind: 'torch' }),
} satisfies SensorAccessController;

/** Un controlador por tipo de sensor. */
export const sensorControllers: Record<SensorKind, SensorAccessController> = {
  accelerometer: accelerometerSource,
  gyroscope: gyroscopeSource,
  magnetometer: magnetometerSource,
  barometer: barometerSource,
  light: lightSource,
  location: locationController,
  camera: cameraController,
  microphone: microphoneController,
  bluetooth: androidOnlyController('bluetooth'),
  wifi: androidOnlyController('wifi'),
  gnss: androidOnlyController('gnss'),
  torch: torchController,
  speaker: staticController('speaker', { status: 'available' }),
  vibrator: staticController('vibrator', { status: 'available' }),
};
