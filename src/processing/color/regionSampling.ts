import { srgbComponentToLinear } from './colorSpaces';
import type { LinearRgb } from './colorSpaces';

/** Región en coordenadas normalizadas [0, 1] respecto al fotograma. */
export interface NormalizedRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PixelLayout = 'rgba' | 'bgra';

export interface RegionColorStatistics {
  /** Media en RGB lineal: promediar en lineal es físicamente correcto (mezcla de luz). */
  meanLinear: LinearRgb;
  /** Desviación típica por canal (lineal): si es alta, la región no es uniforme. */
  standardDeviationLinear: LinearRgb;
  sampledPixelCount: number;
}

/** Tabla sRGB (0-255) → lineal, para no calcular potencias por píxel. */
export function createSrgbToLinearTable(): Float64Array {
  const lookupTable = new Float64Array(256);
  for (let encodedValue = 0; encodedValue < 256; encodedValue++) {
    lookupTable[encodedValue] = srgbComponentToLinear(encodedValue);
  }
  return lookupTable;
}

/**
 * Media y dispersión del color dentro de una región de un fotograma de 8 bits por canal.
 * `sampleStride` permite saltar píxeles (2 = uno de cada 2 en cada eje) para ir más rápido.
 */
export function measureRegionColor(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  pixelLayout: PixelLayout,
  region: NormalizedRegion,
  srgbToLinearTable: Float64Array,
  sampleStride = 1,
): RegionColorStatistics | null {
  'worklet';
  const firstColumn = Math.max(0, Math.floor(region.left * frameWidth));
  const firstRow = Math.max(0, Math.floor(region.top * frameHeight));
  const lastColumn = Math.min(frameWidth, Math.ceil((region.left + region.width) * frameWidth));
  const lastRow = Math.min(frameHeight, Math.ceil((region.top + region.height) * frameHeight));
  const redOffset = pixelLayout === 'rgba' ? 0 : 2;
  const blueOffset = pixelLayout === 'rgba' ? 2 : 0;
  const stride = Math.max(1, Math.floor(sampleStride));

  let sampledPixelCount = 0;
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let redSquaredSum = 0;
  let greenSquaredSum = 0;
  let blueSquaredSum = 0;
  for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex += stride) {
    const rowStart = rowIndex * bytesPerRow;
    for (let columnIndex = firstColumn; columnIndex < lastColumn; columnIndex += stride) {
      const pixelStart = rowStart + columnIndex * 4;
      const redValue = srgbToLinearTable[pixels[pixelStart + redOffset]!]!;
      const greenValue = srgbToLinearTable[pixels[pixelStart + 1]!]!;
      const blueValue = srgbToLinearTable[pixels[pixelStart + blueOffset]!]!;
      redSum += redValue;
      greenSum += greenValue;
      blueSum += blueValue;
      redSquaredSum += redValue * redValue;
      greenSquaredSum += greenValue * greenValue;
      blueSquaredSum += blueValue * blueValue;
      sampledPixelCount++;
    }
  }
  if (sampledPixelCount === 0) return null;

  const meanRed = redSum / sampledPixelCount;
  const meanGreen = greenSum / sampledPixelCount;
  const meanBlue = blueSum / sampledPixelCount;
  const standardDeviation = (squaredSum: number, meanValue: number) =>
    Math.sqrt(Math.max(0, squaredSum / sampledPixelCount - meanValue * meanValue));
  return {
    meanLinear: { red: meanRed, green: meanGreen, blue: meanBlue },
    standardDeviationLinear: {
      red: standardDeviation(redSquaredSum, meanRed),
      green: standardDeviation(greenSquaredSum, meanGreen),
      blue: standardDeviation(blueSquaredSum, meanBlue),
    },
    sampledPixelCount,
  };
}
