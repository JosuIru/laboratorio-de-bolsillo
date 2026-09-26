import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface FocusStackMeasurementValues {
  capturedFrameCount: number;
  /** Lado del resultado (px). */
  outputSizePixels: number;
  /** 'auto' (sondeo previo), 'macro' o 'near'. */
  rangeMode: string;
  /** Posiciones del objetivo del barrido (0 = lo más cerca, 1 = infinito). */
  nearLensPosition: number;
  farLensPosition: number;
  focusStepPosition: number;
  /** Mayor cambio de escala entre fotos por el «focus breathing» (%). */
  focusBreathingPercent: number;
  /** Foto (0 = la más cercana) que estaba mejor enfocada en conjunto. */
  bestSingleFrameIndex: number;
  captureSeconds: number;
  processingSeconds: number;
}

export const focusStackSchema = defineMeasurementSchema<FocusStackMeasurementValues>(1, [
  { key: 'capturedFrameCount', labelKey: 'fields.capturedFrameCount', type: 'number' },
  { key: 'outputSizePixels', labelKey: 'fields.outputSize', type: 'number', unit: 'px' },
  { key: 'rangeMode', labelKey: 'fields.rangeMode', type: 'string' },
  { key: 'nearLensPosition', labelKey: 'fields.nearLensPosition', type: 'number' },
  { key: 'farLensPosition', labelKey: 'fields.farLensPosition', type: 'number' },
  { key: 'focusStepPosition', labelKey: 'fields.focusStep', type: 'number' },
  { key: 'focusBreathingPercent', labelKey: 'fields.focusBreathing', type: 'number', unit: '%' },
  { key: 'bestSingleFrameIndex', labelKey: 'fields.bestSingleFrame', type: 'number' },
  { key: 'captureSeconds', labelKey: 'fields.captureSeconds', type: 'number', unit: 's' },
  { key: 'processingSeconds', labelKey: 'fields.processingSeconds', type: 'number', unit: 's' },
]);
