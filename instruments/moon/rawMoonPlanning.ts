/**
 * Dónde está la Luna en una foto RAW (lógica pura).
 *
 * El DNG es SIEMPRE el sensor entero: el zoom digital (un recorte centrado que la cámara amplía)
 * no se aplica al RAW. Un punto de la vista previa, que muestra el campo ampliado, cae en el RAW
 * en  centro + (punto_escalado − centro) / zoom,  y la Luna mide allí 1/zoom de lo que mide en
 * la vista previa escalada. Se supone que la vista previa y el sensor tienen la misma proporción
 * (4:3), como en el resto de la pantalla de la Luna.
 */
import { type PixelRect, type PixelSize, squareCropAround } from '@/core/camera/photoCropGeometry';

/** Lado mínimo y máximo de la zona que se lee del RAW (a resolución completa). */
const minimumRawRegionSide = 192;
export const maximumRawRegionSide = 1024;
/** Margen para lo que se mueva la Luna y para el error de la correspondencia, en radios. */
const regionSideInRadii = 5;
/** Además, una fracción del campo ampliado visible (por si la vista previa no es exacta). */
const visibleFieldMarginFraction = 0.15;

export interface PreviewMoonDetection {
  centerX: number;
  centerY: number;
  radiusPixels: number;
  frameWidth: number;
  frameHeight: number;
}

/** Radio esperado de la Luna en píxeles del RAW. */
export function expectedRawMoonRadius(detection: PreviewMoonDetection, zoomFactor: number, uprightRawSize: PixelSize): number {
  return (detection.radiusPixels * (uprightRawSize.width / detection.frameWidth)) / Math.max(1, zoomFactor);
}

/** Zona cuadrada del RAW derecho (ya girado como la pantalla) que contiene la Luna. */
export function planRawMoonRegion(detection: PreviewMoonDetection, zoomFactor: number, uprightRawSize: PixelSize): PixelRect {
  const effectiveZoom = Math.max(1, zoomFactor);
  const scaledCenterX = (detection.centerX / detection.frameWidth) * uprightRawSize.width;
  const scaledCenterY = (detection.centerY / detection.frameHeight) * uprightRawSize.height;
  const rawCenter = {
    x: uprightRawSize.width / 2 + (scaledCenterX - uprightRawSize.width / 2) / effectiveZoom,
    y: uprightRawSize.height / 2 + (scaledCenterY - uprightRawSize.height / 2) / effectiveZoom,
  };
  const moonRadius = expectedRawMoonRadius(detection, zoomFactor, uprightRawSize);
  const visibleFieldSide = Math.min(uprightRawSize.width, uprightRawSize.height) / effectiveZoom;
  const desiredSide = regionSideInRadii * moonRadius + visibleFieldMarginFraction * visibleFieldSide;
  const side = Math.min(maximumRawRegionSide, Math.max(minimumRawRegionSide, desiredSide));
  return squareCropAround(rawCenter, side, uprightRawSize);
}
