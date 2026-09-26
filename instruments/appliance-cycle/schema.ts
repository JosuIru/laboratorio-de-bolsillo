import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface ApplianceCycleMeasurementValues {
  cycleDurationSeconds: number;
  /** Hora local de inicio y fin, «2026-09-26 10:05». */
  startTime: string;
  endTime: string;
  /** Valor eficaz medio de la aceleración dinámica mientras estuvo en marcha. */
  meanLevel: number;
  peakLevel: number;
  threshold: number;
  /** Falta si se empezó con «Ya está en marcha» antes de medir el fondo. */
  backgroundLevel?: number;
  quietMinutesToFinish: number;
  /** Se empezó a vigilar con la máquina en marcha: la duración solo cubre la parte vigilada. */
  wasStartAssumed?: boolean;
}

export const applianceCycleSchema = defineMeasurementSchema<ApplianceCycleMeasurementValues>(1, [
  { key: 'cycleDurationSeconds', labelKey: 'fields.cycleDuration', type: 'number', unit: 's' },
  { key: 'startTime', labelKey: 'fields.startTime', type: 'string' },
  { key: 'endTime', labelKey: 'fields.endTime', type: 'string' },
  { key: 'meanLevel', labelKey: 'fields.meanLevel', type: 'number', unit: 'm/s²' },
  { key: 'peakLevel', labelKey: 'fields.peakLevel', type: 'number', unit: 'm/s²' },
  { key: 'threshold', labelKey: 'fields.threshold', type: 'number', unit: 'm/s²' },
  { key: 'backgroundLevel', labelKey: 'fields.backgroundLevel', type: 'number', unit: 'm/s²', optional: true },
  { key: 'quietMinutesToFinish', labelKey: 'fields.quietMinutes', type: 'number', unit: 'min' },
  { key: 'wasStartAssumed', labelKey: 'fields.startAssumed', type: 'boolean', optional: true },
]);
