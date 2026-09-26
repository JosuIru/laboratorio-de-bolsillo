/**
 * Apilado monocromo de fotos RAW (canal verde) de la Luna, alineadas por el disco.
 *
 * Cada foto llega como imagen gris lineal (el verde del mosaico, `extractGreenChannel`). Se
 * ajusta el disco con precisión subpíxel en cada una (`fitLunarDiskTolerantOfBlur`), se ordenan
 * por nitidez del limbo (`measureLunarFocusScore`), se queda la fracción más nítida y se
 * remuestrean todas (bilineal) sobre una rejilla común centrada en el disco, `upsampleFactor`
 * veces más fina: como cada foto cae con un resto subpíxel distinto, la media sobre la rejilla
 * fina recupera algo de resolución (la misma idea que el «drizzle», en sencillo).
 *
 * Módulo puro: sin React ni React Native.
 */

import { measureLunarFocusScore } from './focusBracketing';
import { createGrayImage, type GrayImage, sampleBilinear } from './grayImage';
import type { Circle } from './lunarDiskFit';
import { fitLunarDiskTolerantOfBlur } from './limbProfiles';

export interface MonoStackOptions {
  /** Fracción más nítida que se apila (al menos una foto). */
  keptFraction: number;
  /** Cuántas veces más fina es la rejilla de salida. */
  upsampleFactor: number;
  /** Lado máximo de la imagen de salida. */
  maximumOutputSide: number;
}

export const defaultMonoStackOptions: MonoStackOptions = {
  keptFraction: 0.5,
  upsampleFactor: 2,
  maximumOutputSide: 800,
};

export interface MonoStackResult {
  stackedImage: GrayImage;
  /** La foto más nítida sola, en la misma rejilla (para comparar). */
  bestSingleImage: GrayImage;
  usedFrameCount: number;
  /** Radio medio del disco en píxeles de las fotos de entrada. */
  diskRadiusPixels: number;
  upsampleFactor: number;
  /** Discos ajustados de las fotos usadas (entrada), de la más nítida a la menos. */
  usedDiskCircles: Circle[];
}

/** Gira una imagen gris un múltiplo de 90° en sentido horario y, si se pide, la refleja después. */
export function rotateGrayImage(image: GrayImage, clockwiseDegrees: 0 | 90 | 180 | 270, isMirrored = false): GrayImage {
  const swapsSides = clockwiseDegrees === 90 || clockwiseDegrees === 270;
  const outputWidth = swapsSides ? image.height : image.width;
  const outputHeight = swapsSides ? image.width : image.height;
  const outputValues = new Float32Array(outputWidth * outputHeight);
  for (let outputRow = 0; outputRow < outputHeight; outputRow++) {
    for (let outputColumn = 0; outputColumn < outputWidth; outputColumn++) {
      const rotatedColumn = isMirrored ? outputWidth - 1 - outputColumn : outputColumn;
      let sourceColumn: number;
      let sourceRow: number;
      switch (clockwiseDegrees) {
        case 90:
          sourceColumn = outputRow;
          sourceRow = image.height - 1 - rotatedColumn;
          break;
        case 180:
          sourceColumn = image.width - 1 - rotatedColumn;
          sourceRow = image.height - 1 - outputRow;
          break;
        case 270:
          sourceColumn = image.width - 1 - outputRow;
          sourceRow = rotatedColumn;
          break;
        default:
          sourceColumn = rotatedColumn;
          sourceRow = outputRow;
      }
      outputValues[outputRow * outputWidth + outputColumn] = image.values[sourceRow * image.width + sourceColumn]!;
    }
  }
  return createGrayImage(outputWidth, outputHeight, outputValues);
}

/** Remuestrea una imagen en una rejilla `side`² centrada en el disco, `upsampleFactor` veces más fina. */
function resampleOnDiskGrid(image: GrayImage, diskCircle: Circle, side: number, upsampleFactor: number, target: Float32Array) {
  // Centro de píxel en coordenadas enteras: el centro de la rejilla, (side − 1)/2, cae en el del disco.
  const gridCenter = (side - 1) / 2;
  for (let outputRow = 0; outputRow < side; outputRow++) {
    const sourceY = diskCircle.centerY + (outputRow - gridCenter) / upsampleFactor;
    for (let outputColumn = 0; outputColumn < side; outputColumn++) {
      const sourceX = diskCircle.centerX + (outputColumn - gridCenter) / upsampleFactor;
      target[outputRow * side + outputColumn] = target[outputRow * side + outputColumn]! + sampleBilinear(image, sourceX, sourceY);
    }
  }
}

/** Apila las fotos alineándolas por el disco; `null` si en ninguna se encuentra la Luna. */
export function stackMonoFramesOnDisk(frames: readonly GrayImage[], partialOptions: Partial<MonoStackOptions> = {}): MonoStackResult | null {
  const options = { ...defaultMonoStackOptions, ...partialOptions };
  const scoredFrames = frames.flatMap((frame) => {
    const diskCircle = fitLunarDiskTolerantOfBlur(frame);
    if (!diskCircle) return [];
    const focusScore = measureLunarFocusScore(frame, diskCircle);
    return [{ frame, diskCircle, score: focusScore?.score ?? 0 }];
  });
  if (scoredFrames.length === 0) return null;
  scoredFrames.sort((first, second) => second.score - first.score);
  const keptCount = Math.max(1, Math.round(scoredFrames.length * options.keptFraction));
  const keptFrames = scoredFrames.slice(0, keptCount);
  const diskRadiusPixels = keptFrames.reduce((sum, keptFrame) => sum + keptFrame.diskCircle.radius, 0) / keptFrames.length;
  const desiredSide = Math.round(diskRadiusPixels * 3 * options.upsampleFactor);
  const side = Math.max(32, Math.min(options.maximumOutputSide, desiredSide + (desiredSide % 2)));
  const stackedValues = new Float32Array(side * side);
  for (const keptFrame of keptFrames) resampleOnDiskGrid(keptFrame.frame, keptFrame.diskCircle, side, options.upsampleFactor, stackedValues);
  for (let pixelIndex = 0; pixelIndex < stackedValues.length; pixelIndex++) stackedValues[pixelIndex] = stackedValues[pixelIndex]! / keptFrames.length;
  const bestSingleValues = new Float32Array(side * side);
  resampleOnDiskGrid(keptFrames[0]!.frame, keptFrames[0]!.diskCircle, side, options.upsampleFactor, bestSingleValues);
  return {
    stackedImage: createGrayImage(side, side, stackedValues),
    bestSingleImage: createGrayImage(side, side, bestSingleValues),
    usedFrameCount: keptFrames.length,
    diskRadiusPixels,
    upsampleFactor: options.upsampleFactor,
    usedDiskCircles: keptFrames.map((keptFrame) => keptFrame.diskCircle),
  };
}
