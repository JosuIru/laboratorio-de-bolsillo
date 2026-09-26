/**
 * Corrección de la aberración cromática lateral con el propio disco lunar.
 *
 * La lente del móvil no enfoca todos los colores con el mismo aumento: la imagen roja y la azul
 * son un poco más grandes o más pequeñas que la verde, en proporción a la distancia al eje
 * óptico. En las fotos de la Luna se ve como un borde rosa por un lado y azul por el otro.
 *
 * Localmente (la Luna ocupa una zona diminuta del campo) esa deformación es una ESCALA más un
 * DESPLAZAMIENTO. Y el disco lunar da las dos cosas con precisión subpíxel, canal a canal:
 *  - escala = radio del canal / radio del verde;
 *  - desplazamiento = centro del canal − centro del verde.
 * Luego cada canal se remuestrea (bilineal) para que su disco coincida con el del verde:
 *     posición en el canal = centro_c + escala · (posición − centro_verde).
 *
 * Supuestos: el disco tiene limbo iluminado suficiente en los tres canales (sirve cualquier fase
 * no demasiado fina) y la aberración es lineal dentro del disco (cierto para ~30–300 px).
 * Módulo puro: sin React ni React Native.
 */

import { createGrayImage, type GrayImage, sampleBilinear } from './grayImage';
import type { Circle, DiskFitOptions } from './lunarDiskFit';
import { fitLunarDiskTolerantOfBlur } from './limbProfiles';
import { channelAsGrayImage, type RgbPlanes } from './rgbPlanes';

export interface ChannelGeometry {
  /** Radio del disco en el canal / radio en el verde. */
  scale: number;
  /** Centro del disco en el canal menos el del verde, en píxeles. */
  shiftX: number;
  shiftY: number;
  disk: Circle;
}

export interface ChromaticAberrationMeasurement {
  greenDisk: Circle;
  red: ChannelGeometry;
  blue: ChannelGeometry;
  /** Mayor separación entre el borde de un canal y el del verde en todo el limbo, en píxeles. */
  maximumFringeWidthPixels: number;
}

function channelGeometry(channelDisk: Circle, greenDisk: Circle): ChannelGeometry {
  return {
    scale: channelDisk.radius / greenDisk.radius,
    shiftX: channelDisk.centerX - greenDisk.centerX,
    shiftY: channelDisk.centerY - greenDisk.centerY,
    disk: channelDisk,
  };
}

/** Mayor distancia entre los dos bordes: desplazamiento y diferencia de radio en la peor dirección. */
function maximumEdgeSeparation(geometry: ChannelGeometry, greenDisk: Circle): number {
  return Math.hypot(geometry.shiftX, geometry.shiftY) + Math.abs(geometry.disk.radius - greenDisk.radius);
}

/** Escala y desplazamiento de R y B respecto a G, o `null` si algún canal no tiene disco. */
export function measureLateralChromaticAberration(
  planes: RgbPlanes,
  diskFitOptions: Partial<DiskFitOptions> = {},
): ChromaticAberrationMeasurement | null {
  const greenDisk = fitLunarDiskTolerantOfBlur(channelAsGrayImage(planes, 'green'), diskFitOptions);
  const redDisk = fitLunarDiskTolerantOfBlur(channelAsGrayImage(planes, 'red'), diskFitOptions);
  const blueDisk = fitLunarDiskTolerantOfBlur(channelAsGrayImage(planes, 'blue'), diskFitOptions);
  if (!greenDisk || !redDisk || !blueDisk) return null;
  const red = channelGeometry(redDisk, greenDisk);
  const blue = channelGeometry(blueDisk, greenDisk);
  return {
    greenDisk,
    red,
    blue,
    maximumFringeWidthPixels: Math.max(maximumEdgeSeparation(red, greenDisk), maximumEdgeSeparation(blue, greenDisk)),
  };
}

/** Remuestrea un canal para que su disco caiga sobre el del verde. */
export function resampleChannelOntoGreen(channel: GrayImage, geometry: ChannelGeometry, greenDisk: Circle): GrayImage {
  const resampledImage = createGrayImage(channel.width, channel.height);
  for (let rowIndex = 0; rowIndex < channel.height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < channel.width; columnIndex++) {
      const sourceX = geometry.disk.centerX + geometry.scale * (columnIndex - greenDisk.centerX);
      const sourceY = geometry.disk.centerY + geometry.scale * (rowIndex - greenDisk.centerY);
      resampledImage.values[rowIndex * channel.width + columnIndex] = sampleBilinear(channel, sourceX, sourceY);
    }
  }
  return resampledImage;
}

export interface ChromaticCorrectionResult {
  planes: RgbPlanes;
  measurement: ChromaticAberrationMeasurement;
}

/**
 * Alinea R y B con G. Si no se da la medida, se hace sobre la propia imagen (lo normal: la
 * aberración depende de dónde cae la Luna en el campo). `null` si no se encuentra el disco.
 */
export function correctLateralChromaticAberration(
  planes: RgbPlanes,
  measurement?: ChromaticAberrationMeasurement | null,
): ChromaticCorrectionResult | null {
  const usedMeasurement = measurement ?? measureLateralChromaticAberration(planes);
  if (!usedMeasurement) return null;
  const correctedRed = resampleChannelOntoGreen(channelAsGrayImage(planes, 'red'), usedMeasurement.red, usedMeasurement.greenDisk);
  const correctedBlue = resampleChannelOntoGreen(channelAsGrayImage(planes, 'blue'), usedMeasurement.blue, usedMeasurement.greenDisk);
  return {
    planes: { width: planes.width, height: planes.height, red: correctedRed.values, green: planes.green.slice(), blue: correctedBlue.values },
    measurement: usedMeasurement,
  };
}
