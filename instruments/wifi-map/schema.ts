import { defineMeasurementSchema } from '@/core/measurements/schema';

/** Un mapa de cobertura guardado: plano, puntos medidos y resumen. */
export interface WifiMapMeasurementValues {
  pointCount: number;
  medianRssiDbm: number;
  weakestRssiDbm: number;
  strongestRssiDbm: number;
  /** Porcentaje de la zona medida por debajo del umbral de zona muerta. */
  deadZonePercent: number;
  /** Coordenadas normalizadas (0-1) y RSSI medio de cada punto, en el mismo orden. */
  pointXs: number[];
  pointYs: number[];
  pointRssisDbm: number[];
  /** Habitaciones aplanadas: [izquierda, arriba, derecha, abajo, …] normalizadas. */
  roomCoordinates: number[];
  /** Sitio recomendado para el repetidor (normalizado) o −1 si no hay recomendación. */
  repeaterX: number;
  repeaterY: number;
  networkName: string;
  frequencyMhz: number;
}

export const wifiMapSchema = defineMeasurementSchema<WifiMapMeasurementValues>(1, [
  { key: 'pointCount', labelKey: 'fields.pointCount', type: 'number' },
  { key: 'medianRssiDbm', labelKey: 'fields.medianRssi', type: 'number', unit: 'dBm' },
  { key: 'weakestRssiDbm', labelKey: 'fields.weakestRssi', type: 'number', unit: 'dBm' },
  { key: 'strongestRssiDbm', labelKey: 'fields.strongestRssi', type: 'number', unit: 'dBm' },
  { key: 'deadZonePercent', labelKey: 'fields.deadZonePercent', type: 'number', unit: '%' },
  { key: 'networkName', labelKey: 'fields.networkName', type: 'string' },
  { key: 'frequencyMhz', labelKey: 'fields.frequency', type: 'number', unit: 'MHz' },
  { key: 'repeaterX', labelKey: 'fields.repeaterX', type: 'number' },
  { key: 'repeaterY', labelKey: 'fields.repeaterY', type: 'number' },
  { key: 'pointXs', labelKey: 'fields.pointXs', type: 'numberArray' },
  { key: 'pointYs', labelKey: 'fields.pointYs', type: 'numberArray' },
  { key: 'pointRssisDbm', labelKey: 'fields.pointRssis', type: 'numberArray', unit: 'dBm' },
  { key: 'roomCoordinates', labelKey: 'fields.roomCoordinates', type: 'numberArray' },
]);
