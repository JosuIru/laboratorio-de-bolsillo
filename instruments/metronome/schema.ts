import { defineMeasurementSchema } from '@/core/measurements/schema';

/** El metrónomo no guarda mediciones; el esquema describe su ajuste por si se guarda algún día. */
export interface MetronomeMeasurementValues {
  beatsPerMinute: number;
  beatsPerBar: number;
}

export const metronomeSchema = defineMeasurementSchema<MetronomeMeasurementValues>(1, [
  { key: 'beatsPerMinute', labelKey: 'fields.tempo', type: 'number', unit: 'BPM' },
  { key: 'beatsPerBar', labelKey: 'fields.beatsPerBar', type: 'number' },
]);
