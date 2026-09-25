import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface ResonanceScaleMeasurementValues {
  /** Solo con calibración. */
  estimatedMassGrams?: number;
  /** Intervalo aproximado del 95 % (2σ). */
  massUncertaintyGrams?: number;
  isExtrapolated?: boolean;
  /** Rasgo usado por el modelo ('inverse-amplitude' o 'peak-frequency'). */
  modelFeature?: string;
  isTared: boolean;
  amplitudeRms: number;
  amplitudeSpreadRms: number;
  peakFrequencyHz?: number;
  pulseCount: number;
  sampleRateHz: number;
  noiseRms: number;
}

export const resonanceScaleSchema = defineMeasurementSchema<ResonanceScaleMeasurementValues>(1, [
  { key: 'estimatedMassGrams', labelKey: 'fields.estimatedMass', type: 'number', unit: 'g', optional: true },
  { key: 'massUncertaintyGrams', labelKey: 'fields.massUncertainty', type: 'number', unit: 'g', optional: true },
  { key: 'isExtrapolated', labelKey: 'fields.isExtrapolated', type: 'boolean', optional: true },
  { key: 'modelFeature', labelKey: 'fields.modelFeature', type: 'string', optional: true },
  { key: 'isTared', labelKey: 'fields.isTared', type: 'boolean' },
  { key: 'amplitudeRms', labelKey: 'fields.amplitude', type: 'number', unit: 'm/s²' },
  { key: 'amplitudeSpreadRms', labelKey: 'fields.amplitudeSpread', type: 'number', unit: 'm/s²' },
  { key: 'peakFrequencyHz', labelKey: 'fields.peakFrequency', type: 'number', unit: 'Hz', optional: true },
  { key: 'pulseCount', labelKey: 'fields.pulseCount', type: 'number' },
  { key: 'sampleRateHz', labelKey: 'fields.sampleRate', type: 'number', unit: 'Hz' },
  { key: 'noiseRms', labelKey: 'fields.noise', type: 'number', unit: 'm/s²' },
]);
