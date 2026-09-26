import { defineMeasurementSchema } from '@/core/measurements/schema';

/** Partida resuelta: qué puzle, cuántas cerraduras y cuánto se tardó. */
export interface EscapeLocksMeasurementValues {
  puzzleName: string;
  lockCount: number;
  elapsedSeconds: number;
  /** Tipos de cerradura en orden, separados por comas. */
  lockKinds: string;
}

export const escapeLocksSchema = defineMeasurementSchema<EscapeLocksMeasurementValues>(1, [
  { key: 'puzzleName', labelKey: 'fields.puzzleName', type: 'string' },
  { key: 'elapsedSeconds', labelKey: 'fields.elapsedSeconds', type: 'number', unit: 's' },
  { key: 'lockCount', labelKey: 'fields.lockCount', type: 'number' },
  { key: 'lockKinds', labelKey: 'fields.lockKinds', type: 'string' },
]);
