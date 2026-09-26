import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface PocketSpectrometerMeasurementValues {
  isCalibrated: boolean;
  /** Posición de cada pico en el perfil (0–239), siempre disponible. */
  peakPositions: number[];
  /** Longitud de onda de cada pico, solo con calibración. */
  peakWavelengthsNm?: number[];
  startWavelengthNm?: number;
  endWavelengthNm?: number;
  /** Exposición y balance de blancos fijados («Cámara fijada») al medir; ausente en mediciones antiguas. */
  isCameraLocked?: boolean;
  /** Tiempo de exposición manual con el que se midió (solo con la cámara fijada). */
  exposureDurationSeconds?: number;
  /** ISO manual con el que se midió (solo con la cámara fijada). */
  exposureIso?: number;
  /** Intensidad a lo largo de la línea, reducida a 60 puntos. */
  profile: number[];
}

export const pocketSpectrometerSchema = defineMeasurementSchema<PocketSpectrometerMeasurementValues>(1, [
  { key: 'peakWavelengthsNm', labelKey: 'fields.peakWavelengthsNm', type: 'numberArray', unit: 'nm', optional: true },
  { key: 'peakPositions', labelKey: 'fields.peakPositions', type: 'numberArray' },
  { key: 'isCalibrated', labelKey: 'fields.isCalibrated', type: 'boolean' },
  { key: 'startWavelengthNm', labelKey: 'fields.startWavelengthNm', type: 'number', unit: 'nm', optional: true },
  { key: 'endWavelengthNm', labelKey: 'fields.endWavelengthNm', type: 'number', unit: 'nm', optional: true },
  { key: 'profile', labelKey: 'fields.profile', type: 'numberArray' },
  { key: 'isCameraLocked', labelKey: 'fields.isCameraLocked', type: 'boolean', optional: true },
  { key: 'exposureDurationSeconds', labelKey: 'fields.exposureDurationSeconds', type: 'number', unit: 's', optional: true },
  { key: 'exposureIso', labelKey: 'fields.exposureIso', type: 'number', optional: true },
]);
