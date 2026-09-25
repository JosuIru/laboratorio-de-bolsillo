import {
  Accelerometer,
  type AccelerometerMeasurement,
  Barometer,
  type BarometerMeasurement,
  Gyroscope,
  type GyroscopeMeasurement,
  LightSensor,
  type LightSensorMeasurement,
  Magnetometer,
  type MagnetometerMeasurement,
} from 'expo-sensors';

import type { Vector3 } from '../types';
import { createDeviceSensorSource } from './deviceSensorSource';

/** Gravedad estándar; Expo entrega el acelerómetro en unidades de g. */
export const standardGravityMetersPerSecondSquared = 9.80665;

/** Aceleración en m/s², gravedad incluida. */
export const accelerometerSource = createDeviceSensorSource<AccelerometerMeasurement, Vector3>({
  sensorKind: 'accelerometer',
  unit: 'm/s²',
  nativeSensor: Accelerometer,
  defaultRateHz: 50,
  toValue: ({ x, y, z }) => ({
    x: x * standardGravityMetersPerSecondSquared,
    y: y * standardGravityMetersPerSecondSquared,
    z: z * standardGravityMetersPerSecondSquared,
  }),
});

/** Velocidad angular en rad/s. */
export const gyroscopeSource = createDeviceSensorSource<GyroscopeMeasurement, Vector3>({
  sensorKind: 'gyroscope',
  unit: 'rad/s',
  nativeSensor: Gyroscope,
  defaultRateHz: 50,
  toValue: ({ x, y, z }) => ({ x, y, z }),
});

/** Campo magnético en µT. */
export const magnetometerSource = createDeviceSensorSource<MagnetometerMeasurement, Vector3>({
  sensorKind: 'magnetometer',
  unit: 'µT',
  nativeSensor: Magnetometer,
  defaultRateHz: 20,
  toValue: ({ x, y, z }) => ({ x, y, z }),
});

/** Presión atmosférica en hPa. */
export const barometerSource = createDeviceSensorSource<BarometerMeasurement, number>({
  sensorKind: 'barometer',
  unit: 'hPa',
  nativeSensor: Barometer,
  defaultRateHz: 5,
  toValue: ({ pressure }) => pressure,
});

/** Iluminancia en lux (solo Android). */
export const lightSource = createDeviceSensorSource<LightSensorMeasurement, number>({
  sensorKind: 'light',
  unit: 'lx',
  nativeSensor: LightSensor,
  defaultRateHz: 5,
  toValue: ({ illuminance }) => illuminance,
});
