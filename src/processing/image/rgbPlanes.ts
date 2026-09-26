/**
 * Imagen RGB en coma flotante con un plano por canal (de cualquier tamaño, no solo cuadrada como
 * `FloatRgbImage`), para las operaciones que tratan cada canal por separado: la corrección de la
 * aberración cromática y la Luna mineral.
 *
 * Módulo puro: sin React ni React Native.
 */

import type { GrayImage } from './grayImage';

export interface RgbPlanes {
  width: number;
  height: number;
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
}

export type RgbChannelName = 'red' | 'green' | 'blue';

/** Separa una imagen entrelazada (3 o 4 valores por píxel, en orden R, G, B[, A]). */
export function rgbPlanesFromInterleaved(
  interleavedPixels: Uint8Array | Float32Array,
  width: number,
  height: number,
  valuesPerPixel = 3,
): RgbPlanes {
  if (interleavedPixels.length < width * height * valuesPerPixel) throw new Error('Faltan datos para el tamaño de la imagen');
  const red = new Float32Array(width * height);
  const green = new Float32Array(width * height);
  const blue = new Float32Array(width * height);
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const pixelOffset = pixelIndex * valuesPerPixel;
    red[pixelIndex] = interleavedPixels[pixelOffset]!;
    green[pixelIndex] = interleavedPixels[pixelOffset + 1]!;
    blue[pixelIndex] = interleavedPixels[pixelOffset + 2]!;
  }
  return { width, height, red, green, blue };
}

/** Vuelve a entrelazar (R, G, B) en coma flotante. */
export function rgbPlanesToInterleaved(planes: RgbPlanes): Float32Array {
  const interleavedPixels = new Float32Array(planes.width * planes.height * 3);
  for (let pixelIndex = 0; pixelIndex < planes.width * planes.height; pixelIndex++) {
    interleavedPixels[pixelIndex * 3] = planes.red[pixelIndex]!;
    interleavedPixels[pixelIndex * 3 + 1] = planes.green[pixelIndex]!;
    interleavedPixels[pixelIndex * 3 + 2] = planes.blue[pixelIndex]!;
  }
  return interleavedPixels;
}

/** Un canal como imagen gris (comparte la memoria, no copia). */
export function channelAsGrayImage(planes: RgbPlanes, channelName: RgbChannelName): GrayImage {
  return { width: planes.width, height: planes.height, values: planes[channelName] };
}
