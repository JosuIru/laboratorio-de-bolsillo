import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface MachineDiagnosisMeasurementValues {
  machineName: string;
  verdict: string;
  largestIncreaseDecibels: number;
  mostChangedBand?: string;
  audioOverallDeltaDecibels?: number;
  vibrationOverallDeltaDecibels?: number;
  baselineCapturedAt: number;
  captureDurationSeconds: number;
  audioBandCentersHz: number[];
  audioBandLevelsDecibels: number[];
  vibrationBandCentersHz: number[];
  vibrationBandLevelsDecibels: number[];
}

export const machineDiagnosisSchema = defineMeasurementSchema<MachineDiagnosisMeasurementValues>(1, [
  { key: 'machineName', labelKey: 'fields.machineName', type: 'string' },
  { key: 'verdict', labelKey: 'fields.verdict', type: 'string' },
  { key: 'largestIncreaseDecibels', labelKey: 'fields.largestIncrease', type: 'number', unit: 'dB' },
  { key: 'mostChangedBand', labelKey: 'fields.mostChangedBand', type: 'string', optional: true },
  { key: 'audioOverallDeltaDecibels', labelKey: 'fields.audioOverallDelta', type: 'number', unit: 'dB', optional: true },
  {
    key: 'vibrationOverallDeltaDecibels',
    labelKey: 'fields.vibrationOverallDelta',
    type: 'number',
    unit: 'dB',
    optional: true,
  },
  { key: 'baselineCapturedAt', labelKey: 'fields.baselineCapturedAt', type: 'number' },
  { key: 'captureDurationSeconds', labelKey: 'fields.captureDuration', type: 'number', unit: 's' },
  { key: 'audioBandCentersHz', labelKey: 'fields.audioBandCenters', type: 'numberArray', unit: 'Hz' },
  { key: 'audioBandLevelsDecibels', labelKey: 'fields.audioBandLevels', type: 'numberArray', unit: 'dBFS' },
  { key: 'vibrationBandCentersHz', labelKey: 'fields.vibrationBandCenters', type: 'numberArray', unit: 'Hz' },
  {
    key: 'vibrationBandLevelsDecibels',
    labelKey: 'fields.vibrationBandLevels',
    type: 'numberArray',
    unit: 'dB re 1 m/s²',
  },
]);
