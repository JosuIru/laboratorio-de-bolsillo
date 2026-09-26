import { defineMeasurementSchema } from '@/core/measurements/schema';

/**
 * Resumen de una sesión de registro de ruido. Los niveles van en dB(A) si había calibración
 * (la del analizador de espectro) y en dBFS(A), relativos, si no (`isCalibrated`).
 * El detalle por minuto va como adjunto CSV. No se guarda audio.
 */
export interface NoiseLogMeasurementValues {
  sessionStartTimestamp: number;
  durationSeconds: number;
  isCalibrated: boolean;
  /** Desplazamiento de calibración usado (dB SPL − dBFS), si lo había. */
  calibrationOffsetDecibels?: number;
  equivalentLevelDecibels: number;
  maximumLevelDecibels: number;
  level10Decibels: number;
  level90Decibels: number;
  episodeThresholdDecibels: number;
  minimumEpisodeDurationSeconds: number;
  episodeCount: number;
  /** Lugar que escribe el usuario (p. ej. «dormitorio, ventana cerrada»). */
  placeDescription?: string;
  /** Leq de cada minuto de reloj, en orden. */
  minuteEquivalentLevels: number[];
}

export const noiseLogSchema = defineMeasurementSchema<NoiseLogMeasurementValues>(1, [
  { key: 'equivalentLevelDecibels', labelKey: 'summary.leq', type: 'number', unit: 'dB(A)' },
  { key: 'maximumLevelDecibels', labelKey: 'summary.maximum', type: 'number', unit: 'dB(A)' },
  { key: 'level10Decibels', labelKey: 'summary.level10', type: 'number', unit: 'dB(A)' },
  { key: 'level90Decibels', labelKey: 'summary.level90', type: 'number', unit: 'dB(A)' },
  { key: 'episodeCount', labelKey: 'fields.episodeCount', type: 'number' },
  { key: 'durationSeconds', labelKey: 'fields.duration', type: 'number', unit: 's' },
  { key: 'placeDescription', labelKey: 'fields.place', type: 'string', optional: true },
  { key: 'isCalibrated', labelKey: 'fields.isCalibrated', type: 'boolean' },
  { key: 'calibrationOffsetDecibels', labelKey: 'fields.calibrationOffset', type: 'number', unit: 'dB', optional: true },
  { key: 'episodeThresholdDecibels', labelKey: 'fields.threshold', type: 'number', unit: 'dB(A)' },
  { key: 'minimumEpisodeDurationSeconds', labelKey: 'fields.minimumDuration', type: 'number', unit: 's' },
  { key: 'sessionStartTimestamp', labelKey: 'fields.sessionStart', type: 'number', unit: 'ms' },
  { key: 'minuteEquivalentLevels', labelKey: 'fields.minuteLevels', type: 'numberArray', unit: 'dB(A)' },
]);
