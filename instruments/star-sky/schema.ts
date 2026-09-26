import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface StarSkyMeasurementValues {
  /** 'stack', 'trails' o 'meteors'. */
  mode: string;
  capturedFrameCount: number;
  /** Exposición de cada foto (sin ella, la exposición fue automática). */
  exposureMilliseconds?: number;
  iso?: number;
  // Apilado
  stackedFrameCount?: number;
  starsInStack?: number;
  starsInSingleFrame?: number;
  limitingMagnitudeStack?: number;
  limitingMagnitudeSingle?: number;
  /** Ruido del fondo de una foto suelta / ruido del apilado. */
  noiseReductionFactor?: number;
  largestRotationDegrees?: number;
  fieldWidthDegrees?: number;
  fieldHeightDegrees?: number;
  // Trazos
  trailDurationSeconds?: number;
  // Meteoros
  meteorCount?: number;
  meteorsPerHour?: number;
  watchedMinutes?: number;
  rejectedSlowMoverCount?: number;
}

export const starSkySchema = defineMeasurementSchema<StarSkyMeasurementValues>(1, [
  { key: 'mode', labelKey: 'fields.mode', type: 'string' },
  { key: 'capturedFrameCount', labelKey: 'fields.capturedFrameCount', type: 'number' },
  { key: 'exposureMilliseconds', labelKey: 'fields.exposure', type: 'number', unit: 'ms', optional: true },
  { key: 'iso', labelKey: 'fields.iso', type: 'number', optional: true },
  { key: 'stackedFrameCount', labelKey: 'fields.stackedFrameCount', type: 'number', optional: true },
  { key: 'starsInStack', labelKey: 'fields.starsInStack', type: 'number', optional: true },
  { key: 'starsInSingleFrame', labelKey: 'fields.starsInSingleFrame', type: 'number', optional: true },
  { key: 'limitingMagnitudeStack', labelKey: 'fields.limitingMagnitudeStack', type: 'number', unit: 'mag', optional: true },
  { key: 'limitingMagnitudeSingle', labelKey: 'fields.limitingMagnitudeSingle', type: 'number', unit: 'mag', optional: true },
  { key: 'noiseReductionFactor', labelKey: 'fields.noiseReductionFactor', type: 'number', unit: '×', optional: true },
  { key: 'largestRotationDegrees', labelKey: 'fields.largestRotation', type: 'number', unit: '°', optional: true },
  { key: 'fieldWidthDegrees', labelKey: 'fields.fieldWidth', type: 'number', unit: '°', optional: true },
  { key: 'fieldHeightDegrees', labelKey: 'fields.fieldHeight', type: 'number', unit: '°', optional: true },
  { key: 'trailDurationSeconds', labelKey: 'fields.trailDuration', type: 'number', unit: 's', optional: true },
  { key: 'meteorCount', labelKey: 'fields.meteorCount', type: 'number', optional: true },
  { key: 'meteorsPerHour', labelKey: 'fields.meteorsPerHour', type: 'number', unit: '/h', optional: true },
  { key: 'watchedMinutes', labelKey: 'fields.watchedMinutes', type: 'number', unit: 'min', optional: true },
  { key: 'rejectedSlowMoverCount', labelKey: 'fields.rejectedSlowMoverCount', type: 'number', optional: true },
]);
