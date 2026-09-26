/** Geometría del visor de imágenes: pellizco, arrastre y deslizamiento. Sin React para poder probarla. */

export interface Point {
  x: number;
  y: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ViewTransform {
  scale: number;
  translation: Point;
}

export const minimumZoomScale = 1;
export const maximumZoomScale = 6;
export const doubleTapZoomScale = 2.5;

export const identityTransform: ViewTransform = { scale: 1, translation: { x: 0, y: 0 } };

export function distanceBetween(firstPoint: Point, secondPoint: Point): number {
  return Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y);
}

export function midpointBetween(firstPoint: Point, secondPoint: Point): Point {
  return { x: (firstPoint.x + secondPoint.x) / 2, y: (firstPoint.y + secondPoint.y) / 2 };
}

export function clampScale(scale: number): number {
  return Math.min(maximumZoomScale, Math.max(minimumZoomScale, scale));
}

/**
 * La imagen ocupa el visor entero con escala 1; ampliada, no se deja arrastrar más allá de
 * sus bordes. La transformación se aplica respecto al centro del visor.
 */
export function clampTranslation(translation: Point, scale: number, viewport: ViewportSize): Point {
  const maximumOffsetX = Math.max(0, (viewport.width * scale - viewport.width) / 2);
  const maximumOffsetY = Math.max(0, (viewport.height * scale - viewport.height) / 2);
  // `|| 0` convierte el -0 en 0.
  return {
    x: Math.min(maximumOffsetX, Math.max(-maximumOffsetX, translation.x)) || 0,
    y: Math.min(maximumOffsetY, Math.max(-maximumOffsetY, translation.y)) || 0,
  };
}

/**
 * Transformación durante un pellizco: el punto de la imagen que estaba bajo el centro de los dos
 * dedos al empezar sigue bajo el centro actual de los dedos (aunque se desplacen a la vez).
 * Los puntos son relativos a la esquina superior izquierda del visor.
 */
export function computePinchTransform({
  startTransform,
  startDistance,
  startFocalPoint,
  currentDistance,
  currentFocalPoint,
  viewport,
}: {
  startTransform: ViewTransform;
  startDistance: number;
  startFocalPoint: Point;
  currentDistance: number;
  currentFocalPoint: Point;
  viewport: ViewportSize;
}): ViewTransform {
  const nextScale = clampScale(startDistance > 0 ? (startTransform.scale * currentDistance) / startDistance : startTransform.scale);
  const scaleRatio = nextScale / startTransform.scale;
  const viewportCenter = { x: viewport.width / 2, y: viewport.height / 2 };
  // Posición del foco inicial respecto al centro, en coordenadas de la imagen trasladada.
  const startFocalOffsetX = startFocalPoint.x - viewportCenter.x - startTransform.translation.x;
  const startFocalOffsetY = startFocalPoint.y - viewportCenter.y - startTransform.translation.y;
  const unclampedTranslation = {
    x: currentFocalPoint.x - viewportCenter.x - startFocalOffsetX * scaleRatio,
    y: currentFocalPoint.y - viewportCenter.y - startFocalOffsetY * scaleRatio,
  };
  return { scale: nextScale, translation: clampTranslation(unclampedTranslation, nextScale, viewport) };
}

/** Doble toque: sin zoom, amplía centrando el punto tocado; con zoom, vuelve al tamaño original. */
export function computeDoubleTapTransform(currentTransform: ViewTransform, tapPoint: Point, viewport: ViewportSize): ViewTransform {
  if (currentTransform.scale > minimumZoomScale + 0.01) return identityTransform;
  const unclampedTranslation = {
    x: -(tapPoint.x - viewport.width / 2) * (doubleTapZoomScale - 1),
    y: -(tapPoint.y - viewport.height / 2) * (doubleTapZoomScale - 1),
  };
  return {
    scale: doubleTapZoomScale,
    translation: clampTranslation(unclampedTranslation, doubleTapZoomScale, viewport),
  };
}

export type SwipeDirection = 'next' | 'previous' | 'none';

/**
 * Al soltar sin zoom: un gesto sobre todo horizontal y más largo que el umbral (o rápido)
 * pasa de imagen. Hacia la izquierda, la siguiente.
 */
export function detectSwipe(
  horizontalDistance: number,
  verticalDistance: number,
  horizontalVelocity: number,
  viewportWidth: number,
): SwipeDirection {
  const isMostlyHorizontal = Math.abs(horizontalDistance) > Math.abs(verticalDistance) * 1.5;
  const distanceThreshold = Math.min(80, viewportWidth * 0.2);
  const isLongEnough = Math.abs(horizontalDistance) > distanceThreshold;
  const isFastEnough = Math.abs(horizontalVelocity) > 0.5 && Math.abs(horizontalDistance) > 20;
  if (!isMostlyHorizontal || !(isLongEnough || isFastEnough)) return 'none';
  return horizontalDistance < 0 ? 'next' : 'previous';
}

/** Índice tras pasar de imagen, sin salirse de la lista. */
export function nextImageIndex(currentIndex: number, direction: SwipeDirection, imageCount: number): number {
  if (direction === 'next') return Math.min(imageCount - 1, currentIndex + 1);
  if (direction === 'previous') return Math.max(0, currentIndex - 1);
  return currentIndex;
}
