import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface InfiniteTxalapartaMeasurementValues {
  hits: number;
  misses: number;
  barsReached: number;
  finalBeatsPerMinute: number;
  /** Error medio de las palmadas acertadas (adelanto o retraso), en ms. */
  meanAbsoluteErrorMilliseconds?: number;
}

export const infiniteTxalapartaSchema = defineMeasurementSchema<InfiniteTxalapartaMeasurementValues>(1, [
  { key: 'hits', labelKey: 'fields.hits', type: 'number' },
  { key: 'barsReached', labelKey: 'fields.barsReached', type: 'number' },
  { key: 'finalBeatsPerMinute', labelKey: 'fields.finalBeatsPerMinute', type: 'number', unit: 'bpm' },
  {
    key: 'meanAbsoluteErrorMilliseconds',
    labelKey: 'fields.meanAbsoluteErrorMilliseconds',
    type: 'number',
    unit: 'ms',
    optional: true,
  },
  { key: 'misses', labelKey: 'fields.misses', type: 'number' },
]);
