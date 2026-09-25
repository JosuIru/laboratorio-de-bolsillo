import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface LevelMeasurementValues {
  tiltXDegrees: number;
  tiltYDegrees: number;
}

export const levelMeasurementSchema = defineMeasurementSchema<LevelMeasurementValues>(1, [
  { key: 'tiltXDegrees', labelKey: 'fields.tiltX', type: 'number', unit: '°' },
  { key: 'tiltYDegrees', labelKey: 'fields.tiltY', type: 'number', unit: '°' },
]);
