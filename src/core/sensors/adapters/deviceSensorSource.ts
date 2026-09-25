import type { DeviceSensor } from 'expo-sensors';

import { combineHardwareAndPermission, updateIntervalMsForRate } from '../availabilityRules';
import type { SensorAvailability, SensorKind, SensorSource, TimedSample } from '../types';

interface DeviceSensorSourceConfig<TRawMeasurement extends { timestamp: number }, TValue> {
  sensorKind: SensorKind;
  unit: string;
  nativeSensor: DeviceSensor<TRawMeasurement>;
  defaultRateHz: number;
  /** Convierte la medida nativa de Expo a unidades SI. */
  toValue(rawMeasurement: TRawMeasurement): TValue;
}

/** Adapta un sensor de `expo-sensors` a la interfaz común del núcleo. */
export function createDeviceSensorSource<TRawMeasurement extends { timestamp: number }, TValue>(
  config: DeviceSensorSourceConfig<TRawMeasurement, TValue>,
): SensorSource<TValue> {
  const { sensorKind, unit, nativeSensor, defaultRateHz, toValue } = config;

  async function readAvailability(shouldRequestPermission: boolean): Promise<SensorAvailability> {
    try {
      const isHardwarePresent = await nativeSensor.isAvailableAsync();
      if (!isHardwarePresent) return combineHardwareAndPermission(sensorKind, false, null);
      const permission = shouldRequestPermission
        ? await nativeSensor.requestPermissionsAsync()
        : await nativeSensor.getPermissionsAsync();
      return combineHardwareAndPermission(sensorKind, true, permission);
    } catch {
      return combineHardwareAndPermission(sensorKind, false, null);
    }
  }

  return {
    sensorKind,
    unit,
    checkAvailability: () => readAvailability(false),
    requestPermission: () => readAvailability(true),
    subscribe(onSample: (sample: TimedSample<TValue>) => void, options) {
      nativeSensor.setUpdateInterval(updateIntervalMsForRate(options?.targetRateHz, defaultRateHz));
      const subscription = nativeSensor.addListener((rawMeasurement) => {
        onSample({ timestampSeconds: rawMeasurement.timestamp, value: toValue(rawMeasurement) });
      });
      return () => subscription.remove();
    },
  };
}
