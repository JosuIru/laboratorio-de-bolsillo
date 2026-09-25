import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface MetalDetectorMeasurementValues {
  /** |B0|: módulo de la línea base al poner a cero (µT). */
  baselineMagnitudeMicroteslas: number;
  /** Máxima desviación |B − B0| desde el último cero (µT). */
  peakDeviationMicroteslas: number;
  /** |B| al guardar (µT). */
  currentMagnitudeMicroteslas: number;
  /** Umbral de aviso de la sensibilidad elegida (µT). */
  alertThresholdMicroteslas: number;
  sensitivity: string;
  isHardIronCalibrated: boolean;
}

export const metalDetectorSchema = defineMeasurementSchema<MetalDetectorMeasurementValues>(1, [
  { key: 'peakDeviationMicroteslas', labelKey: 'fields.peakDeviation', type: 'number', unit: 'µT' },
  { key: 'currentMagnitudeMicroteslas', labelKey: 'fields.currentMagnitude', type: 'number', unit: 'µT' },
  { key: 'baselineMagnitudeMicroteslas', labelKey: 'fields.baselineMagnitude', type: 'number', unit: 'µT' },
  { key: 'alertThresholdMicroteslas', labelKey: 'fields.alertThreshold', type: 'number', unit: 'µT' },
  { key: 'sensitivity', labelKey: 'fields.sensitivity', type: 'string' },
  { key: 'isHardIronCalibrated', labelKey: 'fields.isCalibrated', type: 'boolean' },
]);
