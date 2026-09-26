/**
 * Geometría pura de los recortes de fotos (sin React ni React Native).
 *
 * Tres sistemas de coordenadas:
 * - **Guardada**: los píxeles tal como los decodifica el móvil (en Android, apaisados como el
 *   sensor; el EXIF dice cuánto girarlos).
 * - **Derecha**: la foto girada para verse como en la pantalla (en esta app, siempre vertical).
 * - **Vista**: la vista previa en pantalla, con `resizeMode="contain"`.
 *
 * Los recortes se planean en la foto derecha (lo que ve el usuario) y se traducen a la guardada
 * para recortar antes de girar: así solo se gira el recorte, no la foto de 12 MP.
 */
import type { ClockwiseRotationDegrees } from '@/processing/image/jpegPhoto';

import { containedFrameRect, type PreviewPoint, type PreviewRect } from './previewGeometry';

export interface PixelSize {
  width: number;
  height: number;
}

/** Rectángulo en píxeles enteros. */
export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Tamaño tras girar `clockwiseDegrees` (90 y 270 intercambian ancho y alto). */
export function rotatedSize(size: PixelSize, clockwiseDegrees: ClockwiseRotationDegrees): PixelSize {
  return clockwiseDegrees === 90 || clockwiseDegrees === 270 ? { width: size.height, height: size.width } : size;
}

/**
 * Tamaño derecho de la foto en esta app (pantalla bloqueada en vertical y orientación de la
 * cámara tomada de la interfaz): el lado largo en vertical. Sirve para el tamaño que da la salida
 * de fotos, que viene en píxeles del sensor, sin girar.
 */
export function portraitSize(size: PixelSize): PixelSize {
  return size.width > size.height ? { width: size.height, height: size.width } : size;
}

/**
 * Giro que aún falta aplicar tras decodificar. Android decodifica sin mirar el EXIF, pero otros
 * decodificadores ya giran la imagen: si el EXIF pide 90° o 270° y la imagen ya es vertical (las
 * fotos derechas de esta app lo son), se da por girada.
 */
export function rotationStillNeeded(decodedSize: PixelSize, exifClockwiseDegrees: ClockwiseRotationDegrees): ClockwiseRotationDegrees {
  const swapsSides = exifClockwiseDegrees === 90 || exifClockwiseDegrees === 270;
  if (swapsSides && decodedSize.height > decodedSize.width) return 0;
  return exifClockwiseDegrees;
}

/** Ajusta un rectángulo a píxeles enteros dentro de la imagen (desplazándolo si se sale). */
export function clampRectToImage(rect: PixelRect, imageSize: PixelSize): PixelRect {
  const width = Math.max(1, Math.min(imageSize.width, Math.round(rect.width)));
  const height = Math.max(1, Math.min(imageSize.height, Math.round(rect.height)));
  const left = Math.min(imageSize.width - width, Math.max(0, Math.round(rect.left)));
  const top = Math.min(imageSize.height - height, Math.max(0, Math.round(rect.top)));
  return { left, top, width, height };
}

/** Cuadrado centrado de lado `sidePixels` (como mucho el lado corto de la imagen). */
export function centeredSquareCrop(imageSize: PixelSize, sidePixels: number): PixelRect {
  const side = Math.min(Math.round(sidePixels), imageSize.width, imageSize.height);
  return clampRectToImage(
    { left: Math.floor((imageSize.width - side) / 2), top: Math.floor((imageSize.height - side) / 2), width: side, height: side },
    imageSize,
  );
}

/** Cuadrado de lado `sidePixels` centrado en un punto, desplazado lo justo para no salirse. */
export function squareCropAround(center: PreviewPoint, sidePixels: number, imageSize: PixelSize): PixelRect {
  const side = Math.min(Math.round(sidePixels), imageSize.width, imageSize.height);
  return clampRectToImage({ left: center.x - side / 2, top: center.y - side / 2, width: side, height: side }, imageSize);
}

/**
 * Traduce un rectángulo de la foto derecha a la guardada, sabiendo que la derecha se obtiene
 * girando la guardada `clockwiseDegrees` en sentido horario. `storedSize` es el de la guardada.
 */
export function uprightRectToStoredRect(
  uprightRect: PixelRect,
  storedSize: PixelSize,
  clockwiseDegrees: ClockwiseRotationDegrees,
): PixelRect {
  const { left, top, width, height } = uprightRect;
  switch (clockwiseDegrees) {
    case 90:
      // Guardado (x, y) → derecho (altoGuardado − y, x).
      return { left: top, top: storedSize.height - left - width, width: height, height: width };
    case 180:
      return { left: storedSize.width - left - width, top: storedSize.height - top - height, width, height };
    case 270:
      // Guardado (x, y) → derecho (y, anchoGuardado − x).
      return { left: storedSize.width - top - height, top: left, width: height, height: width };
    default:
      return uprightRect;
  }
}

/**
 * Lleva un punto de una imagen a otra que muestra el mismo campo de visión con otra resolución
 * (p. ej. del fotograma de vídeo a la foto: ambas 4:3 del mismo sensor).
 */
export function scalePointBetweenImages(point: PreviewPoint, fromSize: PixelSize, toSize: PixelSize): PreviewPoint {
  return { x: (point.x / fromSize.width) * toSize.width, y: (point.y / fromSize.height) * toSize.height };
}

/**
 * Rectángulo de la foto derecha dibujado sobre una vista previa `contain` que muestra el mismo
 * campo de visión (la vista previa de CameraX es 4:3, como la foto).
 */
export function photoRectToViewRect(photoRect: PixelRect, photoSize: PixelSize, viewSize: PixelSize): PreviewRect {
  const displayedRect = containedFrameRect({
    viewWidth: viewSize.width,
    viewHeight: viewSize.height,
    frameWidth: photoSize.width,
    frameHeight: photoSize.height,
  });
  return {
    left: displayedRect.left + photoRect.left * displayedRect.displayScale,
    top: displayedRect.top + photoRect.top * displayedRect.displayScale,
    width: photoRect.width * displayedRect.displayScale,
    height: photoRect.height * displayedRect.displayScale,
  };
}
