import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface TraditionalTunerMeasurementValues {
  frequencyHz: number;
  /** Nota objetivo con su octava, p. ej. «La4». */
  noteName: string;
  targetFrequencyHz: number;
  /** Positivo = la nota suena alta. */
  centsOffset: number;
  /** Id del sistema incorporado o nombre de la tabla propia. */
  tuningSystem: string;
  tonicNote: string;
  referenceA4Hz: number;
}

export const traditionalTunerSchema = defineMeasurementSchema<TraditionalTunerMeasurementValues>(1, [
  { key: 'noteName', labelKey: 'fields.noteName', type: 'string' },
  { key: 'centsOffset', labelKey: 'fields.centsOffset', type: 'number', unit: 'ct' },
  { key: 'frequencyHz', labelKey: 'fields.frequencyHz', type: 'number', unit: 'Hz' },
  { key: 'targetFrequencyHz', labelKey: 'fields.targetFrequencyHz', type: 'number', unit: 'Hz' },
  { key: 'tuningSystem', labelKey: 'fields.tuningSystem', type: 'string' },
  { key: 'tonicNote', labelKey: 'fields.tonicNote', type: 'string' },
  { key: 'referenceA4Hz', labelKey: 'fields.referenceA4Hz', type: 'number', unit: 'Hz' },
]);
