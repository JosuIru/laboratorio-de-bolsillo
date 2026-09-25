import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface SingTheNoteMeasurementValues {
  difficulty: string;
  totalPoints: number;
  hitCount: number;
  roundCount: number;
  /** Desviación media en las rondas acertadas; falta si no se acertó ninguna. */
  meanAbsoluteCentsError?: number;
  /** Notas de cada ronda, separadas por comas. */
  targetNotes: string;
  roundPoints: number[];
}

export const singTheNoteSchema = defineMeasurementSchema<SingTheNoteMeasurementValues>(1, [
  { key: 'totalPoints', labelKey: 'fields.totalPoints', type: 'number' },
  { key: 'hitCount', labelKey: 'fields.hitCount', type: 'number' },
  { key: 'roundCount', labelKey: 'fields.roundCount', type: 'number' },
  { key: 'difficulty', labelKey: 'fields.difficulty', type: 'string' },
  {
    key: 'meanAbsoluteCentsError',
    labelKey: 'fields.meanAbsoluteCentsError',
    type: 'number',
    unit: 'ct',
    optional: true,
  },
  { key: 'targetNotes', labelKey: 'fields.targetNotes', type: 'string' },
  { key: 'roundPoints', labelKey: 'fields.roundPoints', type: 'numberArray' },
]);
