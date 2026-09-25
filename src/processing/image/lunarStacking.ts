/**
 * Apilado de fotogramas de un objeto brillante sobre fondo oscuro (la Luna, un planeta):
 *
 * 1. `locateBrightObject` encuentra el objeto en cada fotograma (centroide y radio).
 * 2. `copyCenteredCrop` recorta un cuadrado centrado en él (en el hilo de la cámara).
 * 3. `measureCropSharpness` puntúa la nitidez de cada recorte («lucky imaging»: la turbulencia
 *    del aire hace que unos fotogramas salgan más nítidos que otros).
 * 4. `stackSharpestCrops` alinea con precisión subpíxel y promedia los mejores: el ruido baja
 *    con la raíz del número de fotogramas.
 * 5. `sharpenImage` y `renderImageToRgba` realzan el detalle y estiran el contraste.
 *
 * Módulo puro: sin React ni React Native. Las funciones de los pasos 1 y 2 son worklets.
 */

export interface BrightObjectDetection {
  /** Centroide en píxeles del fotograma. */
  centerX: number;
  centerY: number;
  /** Radio del círculo con la misma área que la zona brillante, en píxeles del fotograma. */
  radiusPixels: number;
  /** Brillo máximo (suma R+G+B, 0-765). */
  peakBrightness: number;
  /** Fracción de la zona brillante con algún canal saturado (≥ 250): si es alta, sobreexpuesta. */
  saturatedFraction: number;
}

/** Contraste mínimo (en suma R+G+B) entre el objeto y el fondo medio para considerarlo hallado. */
const minimumObjectContrast = 60;
/** Muestras mínimas por encima del umbral: descarta píxeles calientes y estrellas sueltas. */
const minimumObjectSampleCount = 12;

/**
 * Busca el objeto brillante principal. Umbral a medio camino entre el fondo medio y el máximo,
 * y centroide de las muestras que lo superan. `sampleStride` salta píxeles para ir rápido.
 * `bytesPerPixel`: 3 (RGB) o 4 (RGBA/BGRA); el orden de canales no importa porque se suman.
 */
export function locateBrightObject(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  bytesPerPixel: number,
  sampleStride: number,
): BrightObjectDetection | null {
  'worklet';
  let brightnessSum = 0;
  let peakBrightness = 0;
  let sampleCount = 0;
  for (let rowIndex = 0; rowIndex < frameHeight; rowIndex += sampleStride) {
    const rowOffset = rowIndex * bytesPerRow;
    for (let columnIndex = 0; columnIndex < frameWidth; columnIndex += sampleStride) {
      const pixelOffset = rowOffset + columnIndex * bytesPerPixel;
      const brightness = pixels[pixelOffset]! + pixels[pixelOffset + 1]! + pixels[pixelOffset + 2]!;
      brightnessSum += brightness;
      if (brightness > peakBrightness) peakBrightness = brightness;
      sampleCount++;
    }
  }
  if (sampleCount === 0) return null;
  const meanBrightness = brightnessSum / sampleCount;
  if (peakBrightness - meanBrightness < minimumObjectContrast) return null;
  const threshold = (meanBrightness + peakBrightness) / 2;

  let weightedXSum = 0;
  let weightedYSum = 0;
  let weightSum = 0;
  let objectSampleCount = 0;
  let saturatedSampleCount = 0;
  for (let rowIndex = 0; rowIndex < frameHeight; rowIndex += sampleStride) {
    const rowOffset = rowIndex * bytesPerRow;
    for (let columnIndex = 0; columnIndex < frameWidth; columnIndex += sampleStride) {
      const pixelOffset = rowOffset + columnIndex * bytesPerPixel;
      const redValue = pixels[pixelOffset]!;
      const greenValue = pixels[pixelOffset + 1]!;
      const blueValue = pixels[pixelOffset + 2]!;
      const brightness = redValue + greenValue + blueValue;
      if (brightness <= threshold) continue;
      // Pesar por el exceso sobre el umbral da un centroide más estable que contar píxeles.
      const weight = brightness - threshold;
      weightedXSum += columnIndex * weight;
      weightedYSum += rowIndex * weight;
      weightSum += weight;
      objectSampleCount++;
      if (redValue >= 250 || greenValue >= 250 || blueValue >= 250) saturatedSampleCount++;
    }
  }
  if (objectSampleCount < minimumObjectSampleCount || weightSum === 0) return null;
  return {
    centerX: weightedXSum / weightSum,
    centerY: weightedYSum / weightSum,
    radiusPixels: Math.sqrt((objectSampleCount * sampleStride * sampleStride) / Math.PI),
    peakBrightness,
    saturatedFraction: saturatedSampleCount / objectSampleCount,
  };
}

/**
 * Copia a `targetRgb` (RGB, `cropSize`² píxeles) el cuadrado de lado `cropSize` cuya esquina
 * superior izquierda es (`cropLeft`, `cropTop`). Fuera del fotograma rellena con negro.
 * `isBgrOrder` invierte rojo y azul (formato BGRA de iOS).
 */
export function copyCenteredCrop(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  bytesPerPixel: number,
  isBgrOrder: boolean,
  cropLeft: number,
  cropTop: number,
  cropSize: number,
  targetRgb: Uint8Array,
): void {
  'worklet';
  const redChannelOffset = isBgrOrder ? 2 : 0;
  const blueChannelOffset = isBgrOrder ? 0 : 2;
  for (let cropRow = 0; cropRow < cropSize; cropRow++) {
    const frameRow = cropTop + cropRow;
    const isRowInside = frameRow >= 0 && frameRow < frameHeight;
    for (let cropColumn = 0; cropColumn < cropSize; cropColumn++) {
      const frameColumn = cropLeft + cropColumn;
      const targetOffset = (cropRow * cropSize + cropColumn) * 3;
      if (!isRowInside || frameColumn < 0 || frameColumn >= frameWidth) {
        targetRgb[targetOffset] = 0;
        targetRgb[targetOffset + 1] = 0;
        targetRgb[targetOffset + 2] = 0;
        continue;
      }
      const pixelOffset = frameRow * bytesPerRow + frameColumn * bytesPerPixel;
      targetRgb[targetOffset] = pixels[pixelOffset + redChannelOffset]!;
      targetRgb[targetOffset + 1] = pixels[pixelOffset + 1]!;
      targetRgb[targetOffset + 2] = pixels[pixelOffset + blueChannelOffset]!;
    }
  }
}

/** Recorte de un fotograma, centrado en el objeto salvo por el resto subpíxel del centroide. */
export interface AlignedCrop {
  /** RGB de 8 bits, `cropSize`² píxeles. */
  rgbPixels: Uint8Array;
  /** Parte fraccionaria (0-1) del centroide que el recorte entero no pudo centrar. */
  fractionalOffsetX: number;
  fractionalOffsetY: number;
}

/** Esquina entera del recorte y resto subpíxel para centrar `cropSize` en (centerX, centerY). */
export function planCenteredCrop(centerX: number, centerY: number, cropSize: number) {
  'worklet';
  const cropLeft = Math.floor(centerX) - cropSize / 2;
  const cropTop = Math.floor(centerY) - cropSize / 2;
  return {
    cropLeft,
    cropTop,
    fractionalOffsetX: centerX - Math.floor(centerX),
    fractionalOffsetY: centerY - Math.floor(centerY),
  };
}

/**
 * Nitidez de un recorte: varianza del laplaciano del brillo. Los bordes de cráteres nítidos dan
 * valores altos; la imagen emborronada por la turbulencia, bajos.
 */
export function measureCropSharpness(rgbPixels: Uint8Array, cropSize: number): number {
  const brightnessAt = (rowIndex: number, columnIndex: number) => {
    const pixelOffset = (rowIndex * cropSize + columnIndex) * 3;
    return rgbPixels[pixelOffset]! + rgbPixels[pixelOffset + 1]! + rgbPixels[pixelOffset + 2]!;
  };
  let laplacianSum = 0;
  let laplacianSquaredSum = 0;
  let sampleCount = 0;
  for (let rowIndex = 1; rowIndex < cropSize - 1; rowIndex++) {
    for (let columnIndex = 1; columnIndex < cropSize - 1; columnIndex++) {
      const laplacian =
        4 * brightnessAt(rowIndex, columnIndex) -
        brightnessAt(rowIndex - 1, columnIndex) -
        brightnessAt(rowIndex + 1, columnIndex) -
        brightnessAt(rowIndex, columnIndex - 1) -
        brightnessAt(rowIndex, columnIndex + 1);
      laplacianSum += laplacian;
      laplacianSquaredSum += laplacian * laplacian;
      sampleCount++;
    }
  }
  if (sampleCount === 0) return 0;
  const meanLaplacian = laplacianSum / sampleCount;
  return laplacianSquaredSum / sampleCount - meanLaplacian * meanLaplacian;
}

/** Imagen RGB en coma flotante (0-255 por canal), `size`² píxeles. */
export interface FloatRgbImage {
  size: number;
  channels: Float32Array;
}

/** Índices de los recortes ordenados de más a menos nítido. */
export function rankCropsBySharpness(crops: readonly AlignedCrop[], cropSize: number): number[] {
  const sharpnessScores = crops.map((crop) => measureCropSharpness(crop.rgbPixels, cropSize));
  return crops.map((_crop, cropIndex) => cropIndex).sort((firstIndex, secondIndex) => sharpnessScores[secondIndex]! - sharpnessScores[firstIndex]!);
}

/**
 * Alinea (con interpolación bilineal, desplazando cada recorte su resto subpíxel) y promedia los
 * recortes indicados. El objeto queda centrado en (size/2, size/2) en el resultado.
 */
export function stackAlignedCrops(crops: readonly AlignedCrop[], cropSize: number): FloatRgbImage {
  const channelSums = new Float32Array(cropSize * cropSize * 3);
  for (const crop of crops) {
    const { rgbPixels, fractionalOffsetX, fractionalOffsetY } = crop;
    for (let rowIndex = 0; rowIndex < cropSize; rowIndex++) {
      const sourceRow = Math.min(rowIndex, cropSize - 2);
      const nextRowWeight = rowIndex < cropSize - 1 ? fractionalOffsetY : 0;
      for (let columnIndex = 0; columnIndex < cropSize; columnIndex++) {
        const sourceColumn = Math.min(columnIndex, cropSize - 2);
        const nextColumnWeight = columnIndex < cropSize - 1 ? fractionalOffsetX : 0;
        const topLeftOffset = (sourceRow * cropSize + sourceColumn) * 3;
        const topRightOffset = topLeftOffset + 3;
        const bottomLeftOffset = topLeftOffset + cropSize * 3;
        const bottomRightOffset = bottomLeftOffset + 3;
        const targetOffset = (rowIndex * cropSize + columnIndex) * 3;
        for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
          const topValue =
            rgbPixels[topLeftOffset + channelIndex]! * (1 - nextColumnWeight) +
            rgbPixels[topRightOffset + channelIndex]! * nextColumnWeight;
          const bottomValue =
            rgbPixels[bottomLeftOffset + channelIndex]! * (1 - nextColumnWeight) +
            rgbPixels[bottomRightOffset + channelIndex]! * nextColumnWeight;
          channelSums[targetOffset + channelIndex] =
            channelSums[targetOffset + channelIndex]! + topValue * (1 - nextRowWeight) + bottomValue * nextRowWeight;
        }
      }
    }
  }
  if (crops.length > 0) {
    for (let valueIndex = 0; valueIndex < channelSums.length; valueIndex++) {
      channelSums[valueIndex] = channelSums[valueIndex]! / crops.length;
    }
  }
  return { size: cropSize, channels: channelSums };
}

/** Pasa un recorte de 8 bits a imagen flotante (para mostrar el mejor fotograma sin apilar). */
export function cropToFloatImage(crop: AlignedCrop, cropSize: number): FloatRgbImage {
  return stackAlignedCrops([crop], cropSize);
}

/** Desenfoque gaussiano separable (bordes replicados). */
export function gaussianBlur(image: FloatRgbImage, sigmaPixels: number): FloatRgbImage {
  const kernelRadius = Math.max(1, Math.ceil(sigmaPixels * 3));
  const kernelWeights = new Float32Array(2 * kernelRadius + 1);
  let kernelSum = 0;
  for (let kernelIndex = -kernelRadius; kernelIndex <= kernelRadius; kernelIndex++) {
    const weight = Math.exp(-(kernelIndex * kernelIndex) / (2 * sigmaPixels * sigmaPixels));
    kernelWeights[kernelIndex + kernelRadius] = weight;
    kernelSum += weight;
  }
  for (let kernelIndex = 0; kernelIndex < kernelWeights.length; kernelIndex++) {
    kernelWeights[kernelIndex] = kernelWeights[kernelIndex]! / kernelSum;
  }

  const { size, channels } = image;
  const clampIndex = (index: number) => (index < 0 ? 0 : index >= size ? size - 1 : index);
  const horizontalPass = new Float32Array(channels.length);
  const verticalPass = new Float32Array(channels.length);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
        let blurredValue = 0;
        for (let kernelIndex = -kernelRadius; kernelIndex <= kernelRadius; kernelIndex++) {
          const sourceOffset = (rowIndex * size + clampIndex(columnIndex + kernelIndex)) * 3 + channelIndex;
          blurredValue += channels[sourceOffset]! * kernelWeights[kernelIndex + kernelRadius]!;
        }
        horizontalPass[(rowIndex * size + columnIndex) * 3 + channelIndex] = blurredValue;
      }
    }
  }
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
        let blurredValue = 0;
        for (let kernelIndex = -kernelRadius; kernelIndex <= kernelRadius; kernelIndex++) {
          const sourceOffset = (clampIndex(rowIndex + kernelIndex) * size + columnIndex) * 3 + channelIndex;
          blurredValue += horizontalPass[sourceOffset]! * kernelWeights[kernelIndex + kernelRadius]!;
        }
        verticalPass[(rowIndex * size + columnIndex) * 3 + channelIndex] = blurredValue;
      }
    }
  }
  return { size, channels: verticalPass };
}

/**
 * Máscara de enfoque: suma `amount` veces la diferencia con una copia desenfocada. Tras apilar,
 * el ruido es bajo y se puede realzar el detalle sin que aparezca grano.
 */
export function sharpenImage(image: FloatRgbImage, sigmaPixels: number, amount: number): FloatRgbImage {
  const blurredImage = gaussianBlur(image, sigmaPixels);
  const sharpenedChannels = new Float32Array(image.channels.length);
  for (let valueIndex = 0; valueIndex < sharpenedChannels.length; valueIndex++) {
    const originalValue = image.channels[valueIndex]!;
    sharpenedChannels[valueIndex] = originalValue + amount * (originalValue - blurredImage.channels[valueIndex]!);
  }
  return { size: image.size, channels: sharpenedChannels };
}

function percentileOfBrightness(image: FloatRgbImage, percentile: number): number {
  const pixelCount = image.size * image.size;
  const brightnessValues = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const pixelOffset = pixelIndex * 3;
    brightnessValues[pixelIndex] =
      (image.channels[pixelOffset]! + image.channels[pixelOffset + 1]! + image.channels[pixelOffset + 2]!) / 3;
  }
  brightnessValues.sort();
  return brightnessValues[Math.min(pixelCount - 1, Math.floor((percentile / 100) * pixelCount))]!;
}

/**
 * Convierte a RGBA de 8 bits estirando el contraste: el percentil 2 del brillo (cielo) pasa a
 * negro y el 99,8 (zonas más claras de la Luna) a blanco. Mantiene la proporción entre canales.
 */
export function renderImageToRgba(image: FloatRgbImage): Uint8Array {
  const blackLevel = percentileOfBrightness(image, 2);
  const whiteLevel = Math.max(blackLevel + 1, percentileOfBrightness(image, 99.8));
  const contrastScale = 255 / (whiteLevel - blackLevel);
  const pixelCount = image.size * image.size;
  const rgbaPixels = new Uint8Array(pixelCount * 4);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
      const stretchedValue = (image.channels[pixelIndex * 3 + channelIndex]! - blackLevel) * contrastScale;
      rgbaPixels[pixelIndex * 4 + channelIndex] = stretchedValue < 0 ? 0 : stretchedValue > 255 ? 255 : Math.round(stretchedValue);
    }
    rgbaPixels[pixelIndex * 4 + 3] = 255;
  }
  return rgbaPixels;
}

/** Lado del recorte para un objeto de radio dado: margen de 1,5 radios, par y acotado. */
export function chooseCropSize(radiusPixels: number, minimumCropSize = 96, maximumCropSize = 600): number {
  const desiredCropSize = Math.round(radiusPixels * 3);
  const evenCropSize = desiredCropSize + (desiredCropSize % 2);
  return Math.max(minimumCropSize, Math.min(maximumCropSize, evenCropSize));
}

/** Radio del desenfoque de la máscara de enfoque: escala con el tamaño, ~1 px por cada 100 px de recorte. */
export function sharpeningSigmaForCropSize(cropSize: number): number {
  return Math.max(1, cropSize / 100);
}

export interface StackingResult {
  stackedImage: FloatRgbImage;
  bestSingleImage: FloatRgbImage;
  usedCropCount: number;
}

/**
 * Proceso completo: ordena por nitidez, apila la fracción `keptFraction` más nítida (al menos
 * uno) y realza el detalle. Devuelve también el mejor fotograma solo, para comparar.
 */
export function stackSharpestCrops(
  crops: readonly AlignedCrop[],
  cropSize: number,
  keptFraction: number,
  sharpeningAmount: number,
): StackingResult {
  if (crops.length === 0) throw new Error('No hay fotogramas para apilar');
  const rankedCropIndices = rankCropsBySharpness(crops, cropSize);
  const usedCropCount = Math.max(1, Math.round(crops.length * keptFraction));
  const keptCrops = rankedCropIndices.slice(0, usedCropCount).map((cropIndex) => crops[cropIndex]!);
  const stackedImage = stackAlignedCrops(keptCrops, cropSize);
  return {
    stackedImage:
      sharpeningAmount > 0 ? sharpenImage(stackedImage, sharpeningSigmaForCropSize(cropSize), sharpeningAmount) : stackedImage,
    bestSingleImage: cropToFloatImage(crops[rankedCropIndices[0]!]!, cropSize),
    usedCropCount,
  };
}
