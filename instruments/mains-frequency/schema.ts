import { defineMeasurementSchema } from '@/core/measurements/schema';
import type { LightType } from '@/processing/flicker/lightClassification';

export interface MainsFrequencyMeasurementValues {
  /** Frecuencia nominal de la red elegida (50 o 60 Hz). */
  nominalMainsFrequencyHz: number;
  /** Frecuencia de la red medida (la mitad de la del parpadeo). */
  mainsFrequencyHz?: number;
  /** Incertidumbre típica (1σ) de la frecuencia de la red, reloj del móvil incluido. */
  mainsFrequencyUncertaintyHz?: number;
  flickerFrequencyHz?: number;
  lightType: LightType;
  /** Porcentaje de parpadeo medido (mínimo: la exposición lo suaviza). */
  percentFlicker?: number;
  /** Sin bandas: porcentaje de parpadeo máximo compatible con la medida. */
  percentFlickerUpperBound?: number;
  flickerIndex?: number;
  harmonicDistortion?: number;
  /** Tiempo de lectura del sensor de un fotograma entero. */
  readoutTimeMilliseconds?: number;
  frameRateHz?: number;
  measurementDurationSeconds?: number;
  phaseCoherence?: number;
}

export const mainsFrequencySchema = defineMeasurementSchema<MainsFrequencyMeasurementValues>(1, [
  { key: 'nominalMainsFrequencyHz', labelKey: 'fields.nominalMainsFrequency', type: 'number', unit: 'Hz' },
  { key: 'mainsFrequencyHz', labelKey: 'fields.mainsFrequency', type: 'number', unit: 'Hz', optional: true },
  {
    key: 'mainsFrequencyUncertaintyHz',
    labelKey: 'fields.mainsFrequencyUncertainty',
    type: 'number',
    unit: 'Hz',
    optional: true,
  },
  { key: 'flickerFrequencyHz', labelKey: 'fields.flickerFrequency', type: 'number', unit: 'Hz', optional: true },
  { key: 'lightType', labelKey: 'fields.lightType', type: 'string' },
  { key: 'percentFlicker', labelKey: 'fields.percentFlicker', type: 'number', unit: '%', optional: true },
  {
    key: 'percentFlickerUpperBound',
    labelKey: 'fields.percentFlickerUpperBound',
    type: 'number',
    unit: '%',
    optional: true,
  },
  { key: 'flickerIndex', labelKey: 'fields.flickerIndex', type: 'number', optional: true },
  { key: 'harmonicDistortion', labelKey: 'fields.harmonicDistortion', type: 'number', optional: true },
  { key: 'readoutTimeMilliseconds', labelKey: 'fields.readoutTime', type: 'number', unit: 'ms', optional: true },
  { key: 'frameRateHz', labelKey: 'fields.frameRate', type: 'number', unit: 'fps', optional: true },
  { key: 'measurementDurationSeconds', labelKey: 'fields.measurementDuration', type: 'number', unit: 's', optional: true },
  { key: 'phaseCoherence', labelKey: 'fields.phaseCoherence', type: 'number', optional: true },
]);
