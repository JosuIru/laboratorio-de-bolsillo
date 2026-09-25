import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface TrackerHunterMeasurementValues {
  /** Rastreadores dedicados (AirTag, SmartTag, Tile…) vistos en la sesión. */
  trackerCount: number;
  /** Cuántos cumplen el criterio «te sigue». */
  followingCount: number;
  /** Cuántos conviene vigilar. */
  watchCount: number;
  /** Otros dispositivos Bluetooth oídos en el último minuto. */
  otherDeviceCount: number;
  /** Tiempo total escaneando en la sesión (min). */
  scanningMinutes: number;
  /** Umbral X de «te sigue» (min). */
  followingThresholdMinutes: number;
  isLocationUsed: boolean;
  /** Resumen legible: tipo, modo y minutos de cada rastreador. */
  trackersSummary: string;
}

export const trackerHunterSchema = defineMeasurementSchema<TrackerHunterMeasurementValues>(1, [
  { key: 'trackerCount', labelKey: 'fields.trackerCount', type: 'number' },
  { key: 'followingCount', labelKey: 'fields.followingCount', type: 'number' },
  { key: 'watchCount', labelKey: 'fields.watchCount', type: 'number' },
  { key: 'otherDeviceCount', labelKey: 'fields.otherDeviceCount', type: 'number' },
  { key: 'scanningMinutes', labelKey: 'fields.scanningMinutes', type: 'number', unit: 'min' },
  { key: 'followingThresholdMinutes', labelKey: 'fields.followingThresholdMinutes', type: 'number', unit: 'min' },
  { key: 'isLocationUsed', labelKey: 'fields.isLocationUsed', type: 'boolean' },
  { key: 'trackersSummary', labelKey: 'fields.trackersSummary', type: 'string' },
]);
