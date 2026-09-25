import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface TachometerMeasurementValues {
  revolutionsPerMinute: number;
  /** Frecuencia de los pulsos que oye el micrófono (rpm × pulsos por vuelta / 60). */
  pulseFrequencyHz: number;
  pulsesPerRevolution: number;
  /** Dispersión relativa de las lecturas al guardar (0,01 = ±1 %). */
  relativeSpread: number;
  isStable: boolean;
  /** Armónicos que destacaban del ruido: más armónicos, más fiable la lectura. */
  detectedHarmonicCount: number;
  sampleRateHz: number;
  fftSize: number;
}

export const tachometerSchema = defineMeasurementSchema<TachometerMeasurementValues>(1, [
  { key: 'revolutionsPerMinute', labelKey: 'fields.revolutionsPerMinute', type: 'number', unit: 'rpm' },
  { key: 'pulseFrequencyHz', labelKey: 'fields.pulseFrequency', type: 'number', unit: 'Hz' },
  { key: 'pulsesPerRevolution', labelKey: 'fields.pulsesPerRevolution', type: 'number' },
  { key: 'relativeSpread', labelKey: 'fields.relativeSpread', type: 'number' },
  { key: 'isStable', labelKey: 'fields.isStable', type: 'boolean' },
  { key: 'detectedHarmonicCount', labelKey: 'fields.detectedHarmonicCount', type: 'number' },
  { key: 'sampleRateHz', labelKey: 'fields.sampleRate', type: 'number', unit: 'Hz' },
  { key: 'fftSize', labelKey: 'fields.fftSize', type: 'number' },
]);
