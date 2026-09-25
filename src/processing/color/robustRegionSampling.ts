import type { NormalizedRegion, PixelLayout, RegionColorStatistics } from './regionSampling';

/** Fracción de píxeles que se descarta por cada extremo de luminancia (reflejos y sombras). */
export const defaultTrimmedLuminanceFraction = 0.2;

/**
 * Como `measureRegionColor`, pero con una media robusta: se ordenan los píxeles por luminancia
 * (con un histograma de 256 niveles, sin ordenar de verdad) y se descarta `trimmedFraction` por
 * arriba y por abajo antes de promediar. Así un reflejo en una almohadilla mojada, el borde de
 * la tira o una sombra no desplazan el color medio. La media y la dispersión se calculan en RGB
 * lineal sobre los píxeles que quedan, sin mezclar canales de píxeles distintos.
 */
export function measureRegionColorRobust(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  pixelLayout: PixelLayout,
  region: NormalizedRegion,
  srgbToLinearTable: Float64Array,
  sampleStride = 1,
  trimmedFraction = defaultTrimmedLuminanceFraction,
): RegionColorStatistics | null {
  'worklet';
  const firstColumn = Math.max(0, Math.floor(region.left * frameWidth));
  const firstRow = Math.max(0, Math.floor(region.top * frameHeight));
  const lastColumn = Math.min(frameWidth, Math.ceil((region.left + region.width) * frameWidth));
  const lastRow = Math.min(frameHeight, Math.ceil((region.top + region.height) * frameHeight));
  const redOffset = pixelLayout === 'bgra' ? 2 : 0;
  const blueOffset = pixelLayout === 'bgra' ? 0 : 2;
  const bytesPerPixel = pixelLayout === 'rgb' ? 3 : 4;
  const stride = Math.max(1, Math.floor(sampleStride));
  const clampedTrimmedFraction = Math.min(0.45, Math.max(0, trimmedFraction));

  // Primera pasada: histograma de luminancia aproximada (pesos Rec. 709 sobre los valores de 8 bits).
  const luminanceHistogram = new Uint32Array(256);
  let candidatePixelCount = 0;
  for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex += stride) {
    const rowStart = rowIndex * bytesPerRow;
    for (let columnIndex = firstColumn; columnIndex < lastColumn; columnIndex += stride) {
      const pixelStart = rowStart + columnIndex * bytesPerPixel;
      const approximateLuminance =
        (54 * pixels[pixelStart + redOffset]! + 183 * pixels[pixelStart + 1]! + 19 * pixels[pixelStart + blueOffset]!) >> 8;
      luminanceHistogram[approximateLuminance]!++;
      candidatePixelCount++;
    }
  }
  if (candidatePixelCount === 0) return null;

  const lowerRank = Math.floor(candidatePixelCount * clampedTrimmedFraction);
  const upperRank = Math.max(lowerRank, Math.ceil(candidatePixelCount * (1 - clampedTrimmedFraction)) - 1);
  let lowestKeptLuminance = 0;
  let highestKeptLuminance = 255;
  let cumulativeCount = 0;
  let isLowerBoundFound = false;
  for (let luminanceLevel = 0; luminanceLevel < 256; luminanceLevel++) {
    cumulativeCount += luminanceHistogram[luminanceLevel]!;
    if (!isLowerBoundFound && cumulativeCount > lowerRank) {
      lowestKeptLuminance = luminanceLevel;
      isLowerBoundFound = true;
    }
    if (cumulativeCount > upperRank) {
      highestKeptLuminance = luminanceLevel;
      break;
    }
  }

  // Segunda pasada: media y dispersión de los píxeles entre los dos percentiles.
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
      const pixelStart = rowStart + columnIndex * bytesPerPixel;
      const encodedRed = pixels[pixelStart + redOffset]!;
      const encodedGreen = pixels[pixelStart + 1]!;
      const encodedBlue = pixels[pixelStart + blueOffset]!;
      const approximateLuminance = (54 * encodedRed + 183 * encodedGreen + 19 * encodedBlue) >> 8;
      if (approximateLuminance < lowestKeptLuminance || approximateLuminance > highestKeptLuminance) continue;
      const redValue = srgbToLinearTable[encodedRed]!;
      const greenValue = srgbToLinearTable[encodedGreen]!;
      const blueValue = srgbToLinearTable[encodedBlue]!;
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
