import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface EarTrainerMeasurementValues {
  /** `intervals` o `scale:<id>`. */
  exercise: string;
  difficulty: string;
  hitCount: number;
  stepCount: number;
  totalPoints: number;
  meanAbsoluteCentsError?: number;
  /** Notas objetivo falladas, separadas por comas: lo que hay que practicar. */
  missedTargets: string;
}

export const earTrainerSchema = defineMeasurementSchema<EarTrainerMeasurementValues>(1, [
  { key: 'exercise', labelKey: 'fields.exercise', type: 'string' },
  { key: 'hitCount', labelKey: 'fields.hitCount', type: 'number' },
  { key: 'stepCount', labelKey: 'fields.stepCount', type: 'number' },
  { key: 'totalPoints', labelKey: 'fields.totalPoints', type: 'number' },
  {
    key: 'meanAbsoluteCentsError',
    labelKey: 'fields.meanAbsoluteCentsError',
    type: 'number',
    unit: 'ct',
    optional: true,
  },
  { key: 'missedTargets', labelKey: 'fields.missedTargets', type: 'string' },
  { key: 'difficulty', labelKey: 'fields.difficulty', type: 'string' },
]);
