/**
 * Geometría pura de la vista previa de la cámara (sin React ni React Native). Sirve para dibujar
 * superposiciones que sigan en su sitio cuando la vista cambia de tamaño (p. ej. al pasar de la
 * vista previa normal a pantalla completa).
 */

export interface PreviewPoint {
  x: number;
  y: number;
}

export interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Rectángulo que ocupa la imagen de la cámara dentro de una vista con `resizeMode="contain"`:
 * centrada y escalada para caber entera. `displayScale` = px de pantalla por px de fotograma.
 */
export function containedFrameRect({
  viewWidth,
  viewHeight,
  frameWidth,
  frameHeight,
}: {
  viewWidth: number;
  viewHeight: number;
  frameWidth: number;
  frameHeight: number;
}): PreviewRect & { displayScale: number } {
  const displayScale = Math.min(viewWidth / frameWidth, viewHeight / frameHeight);
  const displayedWidth = frameWidth * displayScale;
  const displayedHeight = frameHeight * displayScale;
  return {
    left: (viewWidth - displayedWidth) / 2,
    top: (viewHeight - displayedHeight) / 2,
    width: displayedWidth,
    height: displayedHeight,
    displayScale,
  };
}

/** Cuadrado centrado de `squareSidePixels` px de fotograma, en coordenadas de una vista `contain`. */
export function centeredFrameSquareInView({
  viewWidth,
  viewHeight,
  frameWidth,
  frameHeight,
  squareSidePixels,
}: {
  viewWidth: number;
  viewHeight: number;
  frameWidth: number;
  frameHeight: number;
  squareSidePixels: number;
}): PreviewRect {
  const { displayScale } = containedFrameRect({ viewWidth, viewHeight, frameWidth, frameHeight });
  const squareSideOnScreen = squareSidePixels * displayScale;
  return {
    left: (viewWidth - squareSideOnScreen) / 2,
    top: (viewHeight - squareSideOnScreen) / 2,
    width: squareSideOnScreen,
    height: squareSideOnScreen,
  };
}

/**
 * Convierte puntos de cámara a puntos de la vista con el conversor nativo, sin romper si la vista
 * previa aún no está lista (el conversor lanza): ese punto queda en `null` y se reintenta después.
 */
export function convertCameraPointsToViewPoints(
  cameraPoints: readonly (PreviewPoint | null)[],
  convertCameraPointToViewPoint: (cameraPoint: PreviewPoint) => PreviewPoint,
): (PreviewPoint | null)[] {
  return cameraPoints.map((cameraPoint) => {
    if (!cameraPoint) return null;
    try {
      const viewPoint = convertCameraPointToViewPoint(cameraPoint);
      return Number.isFinite(viewPoint.x) && Number.isFinite(viewPoint.y) ? { x: viewPoint.x, y: viewPoint.y } : null;
    } catch {
      return null;
    }
  });
}
