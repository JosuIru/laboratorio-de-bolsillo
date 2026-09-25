import { defineMeasurementSchema } from '@/core/measurements/schema';

/** Resultado de una ronda de «Mantén el pulso». */
export interface RhythmMeasurementValues {
  targetBeatsPerMinute: number;
  score: number;
  /** Media de los desfases (ms): negativo = adelantado. */
  meanAsynchronyMilliseconds: number;
  intervalVariabilityMilliseconds: number;
  /** Positivo = frena, negativo = acelera. */
  tempoDriftPercent: number;
  hitBeatCount: number;
  missedBeatCount: number;
  extraClapCount: number;
  /** Desfase (ms) de cada pulso acertado, en orden. */
  hitOffsetsMilliseconds: number[];
  /** Pulsos sin palmada, contando desde 1. */
  missedBeatNumbers: number[];
}

export const rhythmSchema = defineMeasurementSchema<RhythmMeasurementValues>(1, [
  { key: 'score', labelKey: 'fields.score', type: 'number' },
  { key: 'targetBeatsPerMinute', labelKey: 'fields.targetTempo', type: 'number', unit: 'BPM' },
  { key: 'meanAsynchronyMilliseconds', labelKey: 'fields.meanAsynchrony', type: 'number', unit: 'ms' },
  { key: 'intervalVariabilityMilliseconds', labelKey: 'fields.variability', type: 'number', unit: 'ms' },
  { key: 'tempoDriftPercent', labelKey: 'fields.drift', type: 'number', unit: '%' },
  { key: 'hitBeatCount', labelKey: 'fields.hits', type: 'number' },
  { key: 'missedBeatCount', labelKey: 'fields.missed', type: 'number' },
  { key: 'extraClapCount', labelKey: 'fields.extra', type: 'number' },
  { key: 'hitOffsetsMilliseconds', labelKey: 'fields.offsets', type: 'numberArray', unit: 'ms' },
  { key: 'missedBeatNumbers', labelKey: 'fields.missedBeats', type: 'numberArray' },
]);
