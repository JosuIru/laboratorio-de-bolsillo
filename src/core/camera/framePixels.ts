import type { Frame } from 'react-native-vision-camera';

import type { PixelLayout } from '@/processing/color/regionSampling';

/** Píxeles de un fotograma RGB de vision-camera, con lo necesario para recorrerlos. */
export interface FramePixels {
  pixels: Uint8Array;
  width: number;
  height: number;
  bytesPerRow: number;
  pixelLayout: PixelLayout;
  /** 4 en BGRA/RGBA, 3 en RGB. */
  bytesPerPixel: 3 | 4;
}

/**
 * Lee los píxeles de un fotograma pedido con `pixelFormat: 'rgb'` (worklet). Según el móvil,
 * llegan en BGRA, RGBA o RGB compacto: se deduce del formato y del ancho de cada fila.
 * Devuelve null si el fotograma no trae búfer; el que llama sigue siendo quien lo libera.
 */
export function readFramePixels(frame: Frame): FramePixels | null {
  'worklet';
  if (!frame.hasPixelBuffer) return null;
  const pixelLayout: PixelLayout =
    frame.pixelFormat === 'rgb-bgra-8-bit' ? 'bgra' : frame.bytesPerRow >= frame.width * 4 ? 'rgba' : 'rgb';
  return {
    pixels: new Uint8Array(frame.getPixelBuffer()),
    width: frame.width,
    height: frame.height,
    bytesPerRow: frame.bytesPerRow,
    pixelLayout,
    bytesPerPixel: pixelLayout === 'rgb' ? 3 : 4,
  };
}
