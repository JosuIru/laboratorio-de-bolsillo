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
  /** Cantidad de la máscara de enfoque (0 si se usó la deconvolución o nada). */
  sharpeningAmount: number;
  // Opcionales: las mediciones anteriores a la deconvolución y al alineado por zonas no los tienen.
  /** 'deconvolution', 'unsharpMask' o 'none'. */
  sharpeningMethod?: string;
  /** 'soft', 'medium', 'strong' o 'none'. */
  sharpeningLevel?: string;
  /** σ de la PSF con que se deconvolucionó, en píxeles del resultado. */
  deconvolutionPsfSigmaPixels?: number;
  /** Fotos a las que se aplicó el alineado por zonas. */
  locallyAlignedFrameCount?: number;
  /** Escala del rojo y del azul respecto al verde en la corrección de aberración cromática (1 = nada). */
  redChromaticScale?: number;
  blueChromaticScale?: number;
  /** Tiempo de cálculo tras la ráfaga. */
  processingSeconds?: number;
}

export const superzoomSchema = defineMeasurementSchema<SuperzoomMeasurementValues>(1, [
  { key: 'capturedFrameCount', labelKey: 'fields.capturedFrameCount', type: 'number' },
  { key: 'mergedFrameCount', labelKey: 'fields.mergedFrameCount', type: 'number' },
  { key: 'cropSizePixels', labelKey: 'fields.cropSize', type: 'number', unit: 'px' },
  { key: 'outputSizePixels', labelKey: 'fields.outputSize', type: 'number', unit: 'px' },
  { key: 'zoomFactor', labelKey: 'fields.zoomFactor', type: 'number', unit: '×' },
  { key: 'meanShiftPixels', labelKey: 'fields.meanShift', type: 'number', unit: 'px' },
  { key: 'sharpeningAmount', labelKey: 'fields.sharpeningAmount', type: 'number' },
  { key: 'sharpeningMethod', labelKey: 'fields.sharpeningMethod', type: 'string', optional: true },
  { key: 'sharpeningLevel', labelKey: 'fields.sharpeningLevel', type: 'string', optional: true },
  { key: 'deconvolutionPsfSigmaPixels', labelKey: 'fields.deconvolutionPsfSigma', type: 'number', unit: 'px', optional: true },
  { key: 'locallyAlignedFrameCount', labelKey: 'fields.locallyAlignedFrameCount', type: 'number', optional: true },
  { key: 'redChromaticScale', labelKey: 'fields.redChromaticScale', type: 'number', optional: true },
  { key: 'blueChromaticScale', labelKey: 'fields.blueChromaticScale', type: 'number', optional: true },
  { key: 'processingSeconds', labelKey: 'fields.processingSeconds', type: 'number', unit: 's', optional: true },
]);
