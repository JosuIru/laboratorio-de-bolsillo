import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface SeismographMeasurementValues {
  sampleRateHz: number;
  durationSeconds: number;
  dominantFrequencyHz?: number;
  peakDynamicAcceleration: number;
  rmsDynamicAcceleration: number;
  eventCount: number;
  sensitivityThreshold: number;
  spectrumResolutionHz: number;
  /** Amplitud por bin, de 0 Hz a Nyquist (la serie cruda completa va como adjunto CSV). */
  spectrumAmplitudes: number[];
  /** Tiempo que cubre el CSV adjunto (de la primera a la última muestra, pausas incluidas). */
  seriesDurationSeconds?: number;
  /** La sesión pasó del máximo que se guarda: el CSV solo tiene su principio. */
  isSeriesTruncated?: boolean;
}

export const seismographSchema = defineMeasurementSchema<SeismographMeasurementValues>(1, [
  { key: 'dominantFrequencyHz', labelKey: 'fields.dominantFrequency', type: 'number', unit: 'Hz', optional: true },
  { key: 'peakDynamicAcceleration', labelKey: 'fields.peak', type: 'number', unit: 'm/s²' },
  { key: 'rmsDynamicAcceleration', labelKey: 'fields.rms', type: 'number', unit: 'm/s²' },
  { key: 'eventCount', labelKey: 'fields.events', type: 'number' },
  { key: 'sensitivityThreshold', labelKey: 'fields.threshold', type: 'number', unit: 'm/s²' },
  { key: 'sampleRateHz', labelKey: 'fields.sampleRate', type: 'number', unit: 'Hz' },
  { key: 'durationSeconds', labelKey: 'fields.duration', type: 'number', unit: 's' },
  { key: 'spectrumResolutionHz', labelKey: 'fields.spectrumResolution', type: 'number', unit: 'Hz' },
  { key: 'spectrumAmplitudes', labelKey: 'fields.spectrum', type: 'numberArray', unit: 'm/s²' },
  { key: 'seriesDurationSeconds', labelKey: 'fields.seriesDuration', type: 'number', unit: 's', optional: true },
  { key: 'isSeriesTruncated', labelKey: 'fields.seriesTruncated', type: 'boolean', optional: true },
]);
