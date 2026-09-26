import { defineMeasurementSchema } from '@/core/measurements/schema';

/** Instantánea de lo que estaba sonando: la fuente, su valor y cómo se convertía en sonido. */
export interface DataSonificationMeasurementValues {
  source: string;
  sourceValue: number;
  sourceUnit: string;
  normalizedValue: number;
  mode: string;
  scale: string;
}

export const dataSonificationSchema = defineMeasurementSchema<DataSonificationMeasurementValues>(1, [
  { key: 'source', labelKey: 'fields.source', type: 'string' },
  { key: 'sourceValue', labelKey: 'fields.sourceValue', type: 'number' },
  { key: 'sourceUnit', labelKey: 'fields.sourceUnit', type: 'string' },
  { key: 'normalizedValue', labelKey: 'fields.normalizedValue', type: 'number' },
  { key: 'mode', labelKey: 'fields.mode', type: 'string' },
  { key: 'scale', labelKey: 'fields.scale', type: 'string' },
]);
