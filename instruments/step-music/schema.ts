import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface StepMusicMeasurementValues {
  /** `follow` (la música sigue el paso) o `target` (ritmo fijo para entrenar la cadencia). */
  mode: string;
  durationSeconds: number;
  meanCadence: number;
  targetCadence?: number;
  /** Porcentaje de lecturas a ±3 % de la cadencia objetivo. */
  onPacePercent?: number;
}

export const stepMusicSchema = defineMeasurementSchema<StepMusicMeasurementValues>(1, [
  { key: 'meanCadence', labelKey: 'fields.meanCadence', type: 'number', unit: 'pasos/min' },
  { key: 'durationSeconds', labelKey: 'fields.durationSeconds', type: 'number', unit: 's' },
  { key: 'targetCadence', labelKey: 'fields.targetCadence', type: 'number', unit: 'pasos/min', optional: true },
  { key: 'onPacePercent', labelKey: 'fields.onPacePercent', type: 'number', unit: '%', optional: true },
  { key: 'mode', labelKey: 'fields.mode', type: 'string' },
]);
