import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface ColorimeterMeasurementValues {
  sampleColor: string;
  rawSampleColor: string;
  labLightness: number;
  labGreenRed: number;
  labBlueYellow: number;
  correctionModel: string;
  referencePatchCount: number;
  correctionMeanResidualDeltaE?: number;
  sampleRelativeDeviation: number;
  scaleName?: string;
  nearestScaleLabel?: string;
  nearestScaleDeltaE?: number;
  estimatedValue?: number;
  estimatedValueUnit?: string;
  interpolationDeltaE?: number;
}

export const colorimeterSchema = defineMeasurementSchema<ColorimeterMeasurementValues>(1, [
  { key: 'sampleColor', labelKey: 'fields.sampleColor', type: 'color' },
  { key: 'labLightness', labelKey: 'fields.labLightness', type: 'number' },
  { key: 'labGreenRed', labelKey: 'fields.labGreenRed', type: 'number' },
  { key: 'labBlueYellow', labelKey: 'fields.labBlueYellow', type: 'number' },
  { key: 'estimatedValue', labelKey: 'fields.estimatedValue', type: 'number', optional: true },
  { key: 'estimatedValueUnit', labelKey: 'fields.estimatedValueUnit', type: 'string', optional: true },
  { key: 'nearestScaleLabel', labelKey: 'fields.nearestScaleLabel', type: 'string', optional: true },
  { key: 'nearestScaleDeltaE', labelKey: 'fields.nearestScaleDeltaE', type: 'number', unit: 'ΔE00', optional: true },
  { key: 'interpolationDeltaE', labelKey: 'fields.interpolationDeltaE', type: 'number', unit: 'ΔE00', optional: true },
  { key: 'scaleName', labelKey: 'fields.scaleName', type: 'string', optional: true },
  { key: 'rawSampleColor', labelKey: 'fields.rawSampleColor', type: 'color' },
  { key: 'correctionModel', labelKey: 'fields.correctionModel', type: 'string' },
  { key: 'referencePatchCount', labelKey: 'fields.referencePatchCount', type: 'number' },
  {
    key: 'correctionMeanResidualDeltaE',
    labelKey: 'fields.correctionResidual',
    type: 'number',
    unit: 'ΔE00',
    optional: true,
  },
  { key: 'sampleRelativeDeviation', labelKey: 'fields.sampleRelativeDeviation', type: 'number' },
]);
