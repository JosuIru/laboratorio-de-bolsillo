import { defineMeasurementSchema } from '@/core/measurements/schema';

/**
 * Una medición es o bien la lectura de una estación (role = 'station') o bien el cálculo de la
 * central (role = 'central'); por eso casi todos los campos son opcionales.
 */
export interface SeismicNetworkMeasurementValues {
  role: 'station' | 'central';
  // Estación
  stationName?: string;
  stationXMeters?: number;
  stationYMeters?: number;
  /** Segundos desde el golpe de sincronización. */
  arrivalSeconds?: number;
  sampleRateHz?: number;
  triggerRatio?: number;
  // Central
  /** 'free' (foco y velocidad), 'known-speed' o 'known-source'. */
  locationMethod?: string;
  stationCount?: number;
  sourceXMeters?: number;
  sourceYMeters?: number;
  apparentSpeedMetersPerSecond?: number;
  originTimeSeconds?: number;
  rmsResidualSeconds?: number;
  /** Nombres de las estaciones separados por comas, en el orden de las listas numéricas. */
  stationNames?: string;
  stationXs?: number[];
  stationYs?: number[];
  arrivalTimes?: number[];
  residualsSeconds?: number[];
}

export const seismicNetworkSchema = defineMeasurementSchema<SeismicNetworkMeasurementValues>(1, [
  { key: 'role', labelKey: 'fields.role', type: 'string' },
  { key: 'stationName', labelKey: 'fields.stationName', type: 'string', optional: true },
  { key: 'stationXMeters', labelKey: 'fields.stationX', type: 'number', unit: 'm', optional: true },
  { key: 'stationYMeters', labelKey: 'fields.stationY', type: 'number', unit: 'm', optional: true },
  { key: 'arrivalSeconds', labelKey: 'fields.arrival', type: 'number', unit: 's', optional: true },
  { key: 'sampleRateHz', labelKey: 'fields.sampleRate', type: 'number', unit: 'Hz', optional: true },
  { key: 'triggerRatio', labelKey: 'fields.triggerRatio', type: 'number', optional: true },
  { key: 'locationMethod', labelKey: 'fields.locationMethod', type: 'string', optional: true },
  { key: 'stationCount', labelKey: 'fields.stationCount', type: 'number', optional: true },
  { key: 'sourceXMeters', labelKey: 'fields.sourceX', type: 'number', unit: 'm', optional: true },
  { key: 'sourceYMeters', labelKey: 'fields.sourceY', type: 'number', unit: 'm', optional: true },
  { key: 'apparentSpeedMetersPerSecond', labelKey: 'fields.speed', type: 'number', unit: 'm/s', optional: true },
  { key: 'originTimeSeconds', labelKey: 'fields.originTime', type: 'number', unit: 's', optional: true },
  { key: 'rmsResidualSeconds', labelKey: 'fields.rmsResidual', type: 'number', unit: 's', optional: true },
  { key: 'stationNames', labelKey: 'fields.stationNames', type: 'string', optional: true },
  { key: 'stationXs', labelKey: 'fields.stationXs', type: 'numberArray', unit: 'm', optional: true },
  { key: 'stationYs', labelKey: 'fields.stationYs', type: 'numberArray', unit: 'm', optional: true },
  { key: 'arrivalTimes', labelKey: 'fields.arrivalTimes', type: 'numberArray', unit: 's', optional: true },
  { key: 'residualsSeconds', labelKey: 'fields.residuals', type: 'numberArray', unit: 's', optional: true },
]);
