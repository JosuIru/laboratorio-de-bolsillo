/**
 * Planificación de las capturas especiales de la Luna (lógica pura, sin React ni React Native):
 * el recorte fijo del trípode, las dos exposiciones de la luz cenicienta, el recorte de los
 * fotogramas de vídeo de la imagen afortunada (en el hilo de la cámara) y el alineado de
 * imágenes de un canal por el centro del disco.
 */
import { type GrayImage, sampleBilinear } from '@/processing/image/grayImage';
import type { FloatRgbImage } from '@/processing/image/lunarStacking';

// ---------------------------------------------------------------------------------------------
// Trípode: recorte fijo para la deriva
// ---------------------------------------------------------------------------------------------

/**
 * Velocidad aparente de la Luna respecto a las estrellas fijas por la rotación de la Tierra, en
 * segundos de arco por segundo (15,04″/s en el ecuador celeste; menos a otras declinaciones, y
 * la Luna se retrasa ~0,5″/s). Se toma la máxima: el recorte nunca se queda corto.
 */
export const siderealDriftArcsecondsPerSecond = 15.04;

/**
 * Lado del recorte fijo (en píxeles de la foto) para que la Luna no se salga durante
 * `durationSeconds` sin tocar el móvil, se mueva hacia donde se mueva. No depende del zoom: en
 * un tiempo dado la Luna recorre siempre la misma fracción de su diámetro (su diámetro entero
 * en unos 2 minutos), así que basta el diámetro en la foto y el aparente en el cielo.
 */
export function planDriftCropSide(
  moonDiameterPhotoPixels: number,
  apparentDiameterArcminutes: number,
  durationSeconds: number,
  photoShortSidePixels: number,
  minimumSide = 96,
  maximumSide = 640,
): number {
  const driftDiameters = (siderealDriftArcsecondsPerSecond * durationSeconds) / (apparentDiameterArcminutes * 60);
  const driftPixels = driftDiameters * moonDiameterPhotoPixels;
  // Diámetro + deriva a cada lado + medio diámetro de margen por lado: el recorte se centra en
  // el centroide de la parte iluminada, que en una fase creciente se aparta del centro del disco.
  const desiredSide = Math.ceil(moonDiameterPhotoPixels * 2 + 2 * driftPixels);
  const evenSide = desiredSide + (desiredSide % 2);
  return Math.min(photoShortSidePixels, maximumSide, Math.max(minimumSide, evenSide));
}

/**
 * Radio del disco completo a partir del radio «de igual área» de la zona brillante (el que da
 * `locateBrightObject`): en una fase con fracción iluminada f, el área clara es f·πR².
 */
export function fullDiskRadiusFromBrightArea(equalAreaRadius: number, illuminatedFraction: number): number {
  return equalAreaRadius / Math.sqrt(Math.max(0.05, Math.min(1, illuminatedFraction)));
}

// ---------------------------------------------------------------------------------------------
// Luz cenicienta: dos exposiciones
// ---------------------------------------------------------------------------------------------

export interface ExposureRange {
  minimumSeconds: number;
  maximumSeconds: number;
}

export interface EarthshineExposurePlan {
  shortExposureSeconds: number;
  longExposureSeconds: number;
  /** Larga / corta (con el mismo ISO). */
  exposureRatio: number;
  /** La relación se queda por debajo de la mínima útil por los límites del móvil. */
  isRatioLimited: boolean;
}

/**
 * Exposiciones corta y larga. La corta parte de la que deja la parte iluminada sin quemar; la
 * larga es `targetRatio` veces más, sin pasar del máximo del móvil. Si con eso la relación no
 * llega a `minimumRatio`, se acorta la corta (sale más oscura, pero la parte iluminada tiene
 * luz de sobra).
 */
export function planEarthshineExposures(
  currentExposureSeconds: number,
  exposureRange: ExposureRange,
  targetRatio = 200,
  minimumRatio = 100,
): EarthshineExposurePlan {
  const clampToRange = (exposureSeconds: number) =>
    Math.min(exposureRange.maximumSeconds, Math.max(exposureRange.minimumSeconds, exposureSeconds));
  let shortExposureSeconds = clampToRange(currentExposureSeconds);
  const longExposureSeconds = clampToRange(shortExposureSeconds * targetRatio);
  if (longExposureSeconds / shortExposureSeconds < minimumRatio) {
    shortExposureSeconds = clampToRange(longExposureSeconds / minimumRatio);
  }
  const exposureRatio = longExposureSeconds / shortExposureSeconds;
  return { shortExposureSeconds, longExposureSeconds, exposureRatio, isRatioLimited: exposureRatio < minimumRatio * 0.999 };
}

/**
 * Lado de la zona que se decodifica en la luz cenicienta: el disco entero (con la parte oscura)
 * y margen. Se centra en el centroide de la parte iluminada, que en una fase fina está a casi un
 * radio del centro del disco: por eso 2 radios de margen a cada lado.
 */
export function earthshineRegionSide(fullDiskRadiusPixels: number, photoShortSidePixels: number): number {
  const desiredSide = Math.round(fullDiskRadiusPixels * 4 + photoShortSidePixels * 0.08);
  return Math.min(photoShortSidePixels, Math.max(Math.min(256, photoShortSidePixels), desiredSide));
}

// ---------------------------------------------------------------------------------------------
// Imagen afortunada: recorte de los fotogramas de vídeo
// ---------------------------------------------------------------------------------------------

export interface LuckyFrameCropPlan {
  /** Lado del recorte en píxeles del fotograma. */
  cropSide: number;
  /** Cada píxel entregado promedia `downsampleFactor`² del fotograma. */
  downsampleFactor: number;
  /** Lado de la imagen entregada. */
  outputSide: number;
}

/**
 * Recorte cuadrado alrededor de la Luna en los fotogramas de vídeo, reducido si hace falta para
 * que cada fotograma entregado no pase de `maximumOutputSide` (memoria y tiempo de cálculo).
 */
export function planLuckyFrameCrop(
  fullDiskRadiusFramePixels: number,
  frameShortSidePixels: number,
  maximumOutputSide = 320,
): LuckyFrameCropPlan {
  const desiredSide = Math.round(fullDiskRadiusFramePixels * 2.4);
  const cropSide = Math.max(64, Math.min(frameShortSidePixels, desiredSide));
  const downsampleFactor = Math.max(1, Math.ceil(cropSide / maximumOutputSide));
  const outputSide = Math.floor(cropSide / downsampleFactor);
  return { cropSide: outputSide * downsampleFactor, downsampleFactor, outputSide };
}

/**
 * Copia en luminancia (0-255) un recorte cuadrado de un fotograma RGB/RGBA/BGRA, promediando
 * bloques de `downsampleFactor`². Fuera del fotograma, negro. Worklet: corre en el hilo de la
 * cámara para que al hilo JS solo llegue el recorte, no el fotograma entero.
 */
export function copyGrayCropWithDownsampling(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  bytesPerPixel: number,
  cropLeft: number,
  cropTop: number,
  downsampleFactor: number,
  outputSide: number,
): Uint8Array {
  'worklet';
  const grayPixels = new Uint8Array(outputSide * outputSide);
  const samplesPerBlock = downsampleFactor * downsampleFactor;
  for (let outputRow = 0; outputRow < outputSide; outputRow++) {
    for (let outputColumn = 0; outputColumn < outputSide; outputColumn++) {
      let brightnessSum = 0;
      for (let blockRow = 0; blockRow < downsampleFactor; blockRow++) {
        const frameRow = cropTop + outputRow * downsampleFactor + blockRow;
        if (frameRow < 0 || frameRow >= frameHeight) continue;
        const rowOffset = frameRow * bytesPerRow;
        for (let blockColumn = 0; blockColumn < downsampleFactor; blockColumn++) {
          const frameColumn = cropLeft + outputColumn * downsampleFactor + blockColumn;
          if (frameColumn < 0 || frameColumn >= frameWidth) continue;
          const pixelOffset = rowOffset + frameColumn * bytesPerPixel;
          // Luminancia aproximada sin distinguir rojo de azul (vale igual para RGBA y BGRA).
          brightnessSum += (pixels[pixelOffset]! + 2 * pixels[pixelOffset + 1]! + pixels[pixelOffset + 2]!) / 4;
        }
      }
      grayPixels[outputRow * outputSide + outputColumn] = Math.round(brightnessSum / samplesPerBlock);
    }
  }
  return grayPixels;
}

/** Imagen de un canal a partir de bytes 0-255. */
export function grayImageFromBytes(grayBytes: Uint8Array, side: number): GrayImage {
  return { width: side, height: side, values: Float32Array.from(grayBytes) };
}

// ---------------------------------------------------------------------------------------------
// Utilidades de imagen
// ---------------------------------------------------------------------------------------------

/**
 * Recorte cuadrado de lado `outputSide` centrado en (centerX, centerY) con interpolación
 * bilineal (subpíxel): así varias imágenes quedan alineadas por el centro de su disco.
 */
export function resampleCenteredSquare(image: GrayImage, centerX: number, centerY: number, outputSide: number): GrayImage {
  const values = new Float32Array(outputSide * outputSide);
  const originX = centerX - outputSide / 2;
  const originY = centerY - outputSide / 2;
  for (let rowIndex = 0; rowIndex < outputSide; rowIndex++) {
    for (let columnIndex = 0; columnIndex < outputSide; columnIndex++) {
      const sourceX = originX + columnIndex;
      const sourceY = originY + rowIndex;
      const isInside = sourceX >= 0 && sourceY >= 0 && sourceX <= image.width - 1 && sourceY <= image.height - 1;
      values[rowIndex * outputSide + columnIndex] = isInside ? sampleBilinear(image, sourceX, sourceY) : 0;
    }
  }
  return { width: outputSide, height: outputSide, values };
}

/** Media píxel a píxel de imágenes del mismo tamaño. */
export function averageGrayImages(images: readonly GrayImage[]): GrayImage {
  const [firstImage] = images;
  if (!firstImage) throw new Error('No hay imágenes que promediar');
  const valueSums = new Float32Array(firstImage.values.length);
  for (const image of images) {
    for (let pixelIndex = 0; pixelIndex < valueSums.length; pixelIndex++) {
      valueSums[pixelIndex] = valueSums[pixelIndex]! + image.values[pixelIndex]!;
    }
  }
  for (let pixelIndex = 0; pixelIndex < valueSums.length; pixelIndex++) {
    valueSums[pixelIndex] = valueSums[pixelIndex]! / images.length;
  }
  return { width: firstImage.width, height: firstImage.height, values: valueSums };
}

/**
 * Imagen flotante RGB gris (para mostrarla con `createSkiaImage`) a partir de una de un canal;
 * `valueScale` pasa sus valores a 0-255 (p. ej., 255 si están en 0-1).
 */
export function floatRgbFromGray(image: GrayImage, valueScale = 1): FloatRgbImage {
  if (image.width !== image.height) throw new Error('La imagen debe ser cuadrada');
  const channels = new Float32Array(image.values.length * 3);
  for (let pixelIndex = 0; pixelIndex < image.values.length; pixelIndex++) {
    const scaledValue = image.values[pixelIndex]! * valueScale;
    channels[pixelIndex * 3] = scaledValue;
    channels[pixelIndex * 3 + 1] = scaledValue;
    channels[pixelIndex * 3 + 2] = scaledValue;
  }
  return { size: image.width, channels };
}

/** Ganancias de las ondículas («à trous») para cada nivel de realce: del detalle más fino al más grueso. */
export const waveletGainsBySharpeningLevel: readonly (readonly number[])[] = [
  [1],
  [1.4, 1.2, 1],
  [1.9, 1.5, 1.2, 1],
  [2.6, 2, 1.4, 1.1],
];
