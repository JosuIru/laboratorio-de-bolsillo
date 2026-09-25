import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface SuperzoomMeasurementValues {
  capturedFrameCount: number;
  mergedFrameCount: number;
  /** Lado del recorte central de cada fotograma. */
  cropSizePixels: number;
  /** Lado de la imagen resultante. */
  outputSizePixels: number;
  zoomFactor: number;
  /** Desplazamiento medio de los fotogramas respecto al más nítido: el temblor de la mano. */
  meanShiftPixels: number;
  sharpeningAmount: number;
}

export const superzoomSchema = defineMeasurementSchema<SuperzoomMeasurementValues>(1, [
  { key: 'capturedFrameCount', labelKey: 'fields.capturedFrameCount', type: 'number' },
  { key: 'mergedFrameCount', labelKey: 'fields.mergedFrameCount', type: 'number' },
  { key: 'cropSizePixels', labelKey: 'fields.cropSize', type: 'number', unit: 'px' },
  { key: 'outputSizePixels', labelKey: 'fields.outputSize', type: 'number', unit: 'px' },
  { key: 'zoomFactor', labelKey: 'fields.zoomFactor', type: 'number', unit: '×' },
  { key: 'meanShiftPixels', labelKey: 'fields.meanShift', type: 'number', unit: 'px' },
  { key: 'sharpeningAmount', labelKey: 'fields.sharpeningAmount', type: 'number' },
]);
