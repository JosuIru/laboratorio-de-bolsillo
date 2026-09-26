import { defineMeasurementSchema } from '@/core/measurements/schema';

/**
 * Resumen de una sesión de escucha. Las detecciones una a una (con sus embeddings) van en el
 * registro propio del instrumento, no aquí. No se guarda audio.
 */
export interface WildlifeSoundsMeasurementValues {
  sessionStartTimestamp: number;
  durationSeconds: number;
  analyzedWindowCount: number;
  loggedDetectionCount: number;
  /** Ventanas descartadas por oírse voz humana. */
  humanVoiceWindowCount: number;
  distinctSpeciesCount: number;
  /** «Mirlo común (Turdus merula) ×12; …», de más a menos detecciones. */
  speciesSummary: string;
  bestSpeciesLabel?: string;
  bestSpeciesScore?: number;
  averageAnalysisMilliseconds: number;
  modelVersion: string;
}

export const wildlifeSoundsSchema = defineMeasurementSchema<WildlifeSoundsMeasurementValues>(1, [
  { key: 'speciesSummary', labelKey: 'fields.speciesSummary', type: 'string' },
  { key: 'distinctSpeciesCount', labelKey: 'fields.distinctSpeciesCount', type: 'number' },
  { key: 'loggedDetectionCount', labelKey: 'fields.loggedDetectionCount', type: 'number' },
  { key: 'analyzedWindowCount', labelKey: 'fields.analyzedWindowCount', type: 'number' },
  { key: 'humanVoiceWindowCount', labelKey: 'fields.humanVoiceWindowCount', type: 'number' },
  { key: 'bestSpeciesLabel', labelKey: 'fields.bestSpeciesLabel', type: 'string', optional: true },
  { key: 'bestSpeciesScore', labelKey: 'fields.bestSpeciesScore', type: 'number', optional: true },
  { key: 'durationSeconds', labelKey: 'fields.duration', type: 'number', unit: 's' },
  { key: 'averageAnalysisMilliseconds', labelKey: 'fields.averageAnalysis', type: 'number', unit: 'ms' },
  { key: 'modelVersion', labelKey: 'fields.modelVersion', type: 'string' },
  { key: 'sessionStartTimestamp', labelKey: 'fields.sessionStart', type: 'number', unit: 'ms' },
]);
