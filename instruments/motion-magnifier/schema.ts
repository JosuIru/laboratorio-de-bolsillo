import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface MotionMagnifierMeasurementValues {
  /** pulse, breathing o vibration. */
  band: string;
  dominantFrequencyHz: number;
  /** La frecuencia en la unidad de la banda (lpm, rpm o Hz). */
  displayedRate: number;
  displayedUnit: string;
  /** Potencia del pico frente a la mediana de la banda: cuanto mayor, más claro el pico. */
  peakToMedianPowerRatio: number;
  analysisWindowSeconds: number;
  framesPerSecond: number;
  lowCutoffHz: number;
  highCutoffHz: number;
  amplificationFactor: number;
}

export const motionMagnifierSchema = defineMeasurementSchema<MotionMagnifierMeasurementValues>(1, [
  { key: 'band', labelKey: 'fields.band', type: 'string' },
  { key: 'displayedRate', labelKey: 'fields.displayedRate', type: 'number' },
  { key: 'displayedUnit', labelKey: 'fields.displayedUnit', type: 'string' },
  { key: 'dominantFrequencyHz', labelKey: 'fields.dominantFrequency', type: 'number', unit: 'Hz' },
  { key: 'peakToMedianPowerRatio', labelKey: 'fields.peakToMedianPowerRatio', type: 'number' },
  { key: 'analysisWindowSeconds', labelKey: 'fields.analysisWindow', type: 'number', unit: 's' },
  { key: 'framesPerSecond', labelKey: 'fields.framesPerSecond', type: 'number', unit: 'fps' },
  { key: 'lowCutoffHz', labelKey: 'fields.lowCutoff', type: 'number', unit: 'Hz' },
  { key: 'highCutoffHz', labelKey: 'fields.highCutoff', type: 'number', unit: 'Hz' },
  { key: 'amplificationFactor', labelKey: 'fields.amplificationFactor', type: 'number', unit: '×' },
]);
