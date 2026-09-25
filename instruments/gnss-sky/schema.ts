import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface GnssSkyMeasurementValues {
  /** Satélites distintos recibidos. */
  trackedSatelliteCount: number;
  /** Señales usadas en la posición. */
  usedInFixSignalCount: number;
  constellationCount: number;
  isDualFrequency: boolean;
  /** Media de las 4 señales más fuertes (dB-Hz). */
  topFourMeanCarrierToNoiseDbHz?: number;
  /** 'none' | 'possible' | 'likely' | 'learning'. */
  interferenceLevel: string;
  /** Caída mediana del C/N0 respecto a la línea base (dB). */
  medianCarrierToNoiseDropDb?: number;
  /** Mayor caída del AGC respecto a la línea base (dB). */
  largestAutomaticGainControlDropDb?: number;
  hasAutomaticGainControl: boolean;
  multipathDetectedCount?: number;
  horizontalAccuracyMeters?: number;
}

export const gnssSkySchema = defineMeasurementSchema<GnssSkyMeasurementValues>(1, [
  { key: 'trackedSatelliteCount', labelKey: 'fields.trackedSatelliteCount', type: 'number' },
  { key: 'usedInFixSignalCount', labelKey: 'fields.usedInFixSignalCount', type: 'number' },
  { key: 'constellationCount', labelKey: 'fields.constellationCount', type: 'number' },
  { key: 'isDualFrequency', labelKey: 'fields.isDualFrequency', type: 'boolean' },
  {
    key: 'topFourMeanCarrierToNoiseDbHz',
    labelKey: 'fields.topFourMeanCarrierToNoise',
    type: 'number',
    unit: 'dB-Hz',
    optional: true,
  },
  { key: 'interferenceLevel', labelKey: 'fields.interferenceLevel', type: 'string' },
  { key: 'medianCarrierToNoiseDropDb', labelKey: 'fields.medianCarrierToNoiseDrop', type: 'number', unit: 'dB', optional: true },
  {
    key: 'largestAutomaticGainControlDropDb',
    labelKey: 'fields.largestAutomaticGainControlDrop',
    type: 'number',
    unit: 'dB',
    optional: true,
  },
  { key: 'hasAutomaticGainControl', labelKey: 'fields.hasAutomaticGainControl', type: 'boolean' },
  { key: 'multipathDetectedCount', labelKey: 'fields.multipathDetectedCount', type: 'number', optional: true },
  { key: 'horizontalAccuracyMeters', labelKey: 'fields.horizontalAccuracy', type: 'number', unit: 'm', optional: true },
]);
