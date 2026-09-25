import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface MoonMeasurementValues {
  phaseName: string;
  illuminatedPercent: number;
  ageDays: number;
  distanceKilometers: number;
  apparentDiameterArcminutes: number;
  moonAltitudeDegrees?: number;
  moonAzimuthDegrees?: number;
  capturedFrameCount: number;
  stackedFrameCount: number;
  moonDiameterPixels: number;
  zoomFactor: number;
  exposureBias?: number;
  /** Android: compensación en pasos del móvil (su tamaño en EV depende del modelo). */
  exposureCompensationSteps?: number;
  sharpeningAmount?: number;
}

export const moonSchema = defineMeasurementSchema<MoonMeasurementValues>(1, [
  { key: 'phaseName', labelKey: 'fields.phaseName', type: 'string' },
  { key: 'illuminatedPercent', labelKey: 'fields.illuminatedPercent', type: 'number', unit: '%' },
  { key: 'ageDays', labelKey: 'fields.ageDays', type: 'number', unit: 'd' },
  { key: 'distanceKilometers', labelKey: 'fields.distance', type: 'number', unit: 'km' },
  { key: 'apparentDiameterArcminutes', labelKey: 'fields.apparentDiameter', type: 'number', unit: '′' },
  { key: 'moonAltitudeDegrees', labelKey: 'fields.altitude', type: 'number', unit: '°', optional: true },
  { key: 'moonAzimuthDegrees', labelKey: 'fields.azimuth', type: 'number', unit: '°', optional: true },
  { key: 'capturedFrameCount', labelKey: 'fields.capturedFrameCount', type: 'number' },
  { key: 'stackedFrameCount', labelKey: 'fields.stackedFrameCount', type: 'number' },
  { key: 'moonDiameterPixels', labelKey: 'fields.moonDiameterPixels', type: 'number', unit: 'px' },
  { key: 'zoomFactor', labelKey: 'fields.zoomFactor', type: 'number', unit: '×' },
  { key: 'exposureBias', labelKey: 'fields.exposureBias', type: 'number', unit: 'EV', optional: true },
  {
    key: 'exposureCompensationSteps',
    labelKey: 'fields.exposureCompensationSteps',
    type: 'number',
    optional: true,
  },
  { key: 'sharpeningAmount', labelKey: 'fields.sharpeningAmount', type: 'number', optional: true },
]);
