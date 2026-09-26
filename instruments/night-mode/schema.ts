import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface NightModeMeasurementValues {
  capturedFrameCount: number;
  /** 'tripod' (apoyado) o 'handheld' (en la mano). */
  holdingMode: string;
  /** Tiempo e ISO de cada foto; faltan si el móvil no deja fijar la exposición. */
  exposureSeconds?: number;
  iso?: number;
  outputSizePixels: number;
  /** Ruido de una foto sola ÷ ruido del apilado. */
  noiseReductionFactor: number;
  /** Muestras rechazadas por atípicas (lo que se movió), en %. */
  rejectedPercent: number;
  locallyAlignedFrameCount: number;
  /** Control «Ambiente» (0 = noche, 1 = día). */
  ambience: number;
  /** 'off', 'soft' o 'medium'. */
  noiseReductionLevel: string;
  captureSeconds: number;
  processingSeconds: number;
}

export const nightModeSchema = defineMeasurementSchema<NightModeMeasurementValues>(1, [
  { key: 'capturedFrameCount', labelKey: 'fields.capturedFrameCount', type: 'number' },
  { key: 'holdingMode', labelKey: 'fields.holdingMode', type: 'string' },
  { key: 'exposureSeconds', labelKey: 'fields.exposureSeconds', type: 'number', unit: 's', optional: true },
  { key: 'iso', labelKey: 'fields.iso', type: 'number', optional: true },
  { key: 'outputSizePixels', labelKey: 'fields.outputSize', type: 'number', unit: 'px' },
  { key: 'noiseReductionFactor', labelKey: 'fields.noiseReductionFactor', type: 'number', unit: '×' },
  { key: 'rejectedPercent', labelKey: 'fields.rejectedPercent', type: 'number', unit: '%' },
  { key: 'locallyAlignedFrameCount', labelKey: 'fields.locallyAlignedFrameCount', type: 'number' },
  { key: 'ambience', labelKey: 'fields.ambience', type: 'number' },
  { key: 'noiseReductionLevel', labelKey: 'fields.noiseReductionLevel', type: 'string' },
  { key: 'captureSeconds', labelKey: 'fields.captureSeconds', type: 'number', unit: 's' },
  { key: 'processingSeconds', labelKey: 'fields.processingSeconds', type: 'number', unit: 's' },
]);
