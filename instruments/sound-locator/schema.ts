import { defineMeasurementSchema } from '@/core/measurements/schema';

/** Posición estimada de la palmada, con todo lo necesario para rehacer el cálculo. */
export interface SoundLocatorMeasurementValues {
  positionXMeters: number;
  positionYMeters: number;
  /** Semiejes de la elipse de confianza del 95 %. */
  errorSemiMajorAxisMeters: number;
  errorSemiMinorAxisMeters: number;
  errorOrientationDegrees: number;
  rootMeanSquareResidualMeters: number;
  /** Con tres móviles puede haber dos puntos compatibles con las medidas. */
  isAmbiguous: boolean;
  receiverCount: number;
  /** Índice (0 = A) del móvil que emitió los chirridos. */
  emitterIndex: number;
  temperatureCelsius: number;
  speedOfSoundMetersPerSecond: number;
  receiverXMeters: number[];
  receiverYMeters: number[];
  intervalsMilliseconds: number[];
}

export const soundLocatorSchema = defineMeasurementSchema<SoundLocatorMeasurementValues>(1, [
  { key: 'positionXMeters', labelKey: 'fields.positionX', type: 'number', unit: 'm' },
  { key: 'positionYMeters', labelKey: 'fields.positionY', type: 'number', unit: 'm' },
  { key: 'errorSemiMajorAxisMeters', labelKey: 'fields.errorSemiMajor', type: 'number', unit: 'm' },
  { key: 'errorSemiMinorAxisMeters', labelKey: 'fields.errorSemiMinor', type: 'number', unit: 'm' },
  { key: 'errorOrientationDegrees', labelKey: 'fields.errorOrientation', type: 'number', unit: '°' },
  { key: 'rootMeanSquareResidualMeters', labelKey: 'fields.residual', type: 'number', unit: 'm' },
  { key: 'isAmbiguous', labelKey: 'fields.ambiguous', type: 'boolean' },
  { key: 'receiverCount', labelKey: 'fields.receiverCount', type: 'number' },
  { key: 'emitterIndex', labelKey: 'fields.emitterIndex', type: 'number' },
  { key: 'temperatureCelsius', labelKey: 'fields.temperature', type: 'number', unit: '°C' },
  { key: 'speedOfSoundMetersPerSecond', labelKey: 'fields.speedOfSound', type: 'number', unit: 'm/s' },
  { key: 'receiverXMeters', labelKey: 'fields.receiverX', type: 'numberArray', unit: 'm' },
  { key: 'receiverYMeters', labelKey: 'fields.receiverY', type: 'numberArray', unit: 'm' },
  { key: 'intervalsMilliseconds', labelKey: 'fields.intervals', type: 'numberArray', unit: 'ms' },
]);
