import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface PropellerBalancerMeasurementValues {
  rotationSpeedRpm: number;
  bladeCount: number;
  trialMassGrams: number;
  /** Vibración a 1× sin peso y con el peso de prueba en 0°, 120° y 240° (m/s²). */
  runAmplitudes: number[];
  correctionMassGrams?: number;
  correctionAngleDegrees?: number;
  amplitudeAfterCorrection?: number;
  /** `solved` o el problema que impidió calcular la corrección. */
  outcome: string;
}

export const propellerBalancerSchema = defineMeasurementSchema<PropellerBalancerMeasurementValues>(1, [
  { key: 'correctionMassGrams', labelKey: 'fields.correctionMassGrams', type: 'number', unit: 'g', optional: true },
  {
    key: 'correctionAngleDegrees',
    labelKey: 'fields.correctionAngleDegrees',
    type: 'number',
    unit: '°',
    optional: true,
  },
  { key: 'rotationSpeedRpm', labelKey: 'fields.rotationSpeedRpm', type: 'number', unit: 'rpm' },
  { key: 'runAmplitudes', labelKey: 'fields.runAmplitudes', type: 'numberArray', unit: 'm/s²' },
  {
    key: 'amplitudeAfterCorrection',
    labelKey: 'fields.amplitudeAfterCorrection',
    type: 'number',
    unit: 'm/s²',
    optional: true,
  },
  { key: 'trialMassGrams', labelKey: 'fields.trialMassGrams', type: 'number', unit: 'g' },
  { key: 'bladeCount', labelKey: 'fields.bladeCount', type: 'number' },
  { key: 'outcome', labelKey: 'fields.outcome', type: 'string' },
]);
