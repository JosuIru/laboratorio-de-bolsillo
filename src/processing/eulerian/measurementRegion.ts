/**
 * Zona de medida: un rectángulo de la rejilla que se puede mover tocando la imagen. Se guarda en
 * fracciones del fotograma (0-1), así no depende ni del tamaño de la rejilla (cada banda usa un
 * nivel de pirámide distinto) ni del de la vista.
 */

export interface MeasurementRegion {
  /** Centro del rectángulo en fracciones del ancho y del alto del fotograma. */
  centerXFraction: number;
  centerYFraction: number;
  /** Fracción de cada lado del fotograma que ocupa el rectángulo. */
  sizeFraction: number;
}

/** Fracción de cada lado de la rejilla que forma la zona de medida (antes, el tercio central fijo). */
export const measurementRegionSizeFraction = 1 / 3;

export const centeredMeasurementRegion: MeasurementRegion = {
  centerXFraction: 0.5,
  centerYFraction: 0.5,
  sizeFraction: measurementRegionSizeFraction,
};

/** Mueve el centro a donde se pide, sin que el rectángulo se salga del fotograma. */
export function placeMeasurementRegion(
  requestedCenterXFraction: number,
  requestedCenterYFraction: number,
  sizeFraction = measurementRegionSizeFraction,
): MeasurementRegion {
  const halfSize = sizeFraction / 2;
  const clampToFrame = (centerFraction: number) =>
    Number.isFinite(centerFraction) ? Math.min(1 - halfSize, Math.max(halfSize, centerFraction)) : 0.5;
  return {
    centerXFraction: clampToFrame(requestedCenterXFraction),
    centerYFraction: clampToFrame(requestedCenterYFraction),
    sizeFraction,
  };
}

export interface RegionCellBounds {
  firstColumn: number;
  firstRow: number;
  regionWidth: number;
  regionHeight: number;
}

/**
 * Celdas de una rejilla de `gridWidth × gridHeight` que caen dentro de la zona. Con la zona
 * centrada coincide con el antiguo tercio central (mismo redondeo).
 */
export function regionCellBounds(gridWidth: number, gridHeight: number, region: MeasurementRegion): RegionCellBounds {
  const regionWidth = Math.min(gridWidth, Math.max(1, Math.round(gridWidth * region.sizeFraction)));
  const regionHeight = Math.min(gridHeight, Math.max(1, Math.round(gridHeight * region.sizeFraction)));
  // El pequeño margen evita que 2,9999 (error de coma flotante) baje una celda.
  const firstColumn = Math.floor(region.centerXFraction * gridWidth - regionWidth / 2 + 1e-9);
  const firstRow = Math.floor(region.centerYFraction * gridHeight - regionHeight / 2 + 1e-9);
  return {
    firstColumn: Math.min(gridWidth - regionWidth, Math.max(0, firstColumn)),
    firstRow: Math.min(gridHeight - regionHeight, Math.max(0, firstRow)),
    regionWidth,
    regionHeight,
  };
}

export interface ViewRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Rectángulo que ocupa un fotograma dentro de la vista con `contain` (como la vista previa). */
export function containFrameInView(
  viewWidth: number,
  viewHeight: number,
  frameWidth: number,
  frameHeight: number,
): ViewRectangle | null {
  if (!(viewWidth > 0 && viewHeight > 0 && frameWidth > 0 && frameHeight > 0)) return null;
  const displayScale = Math.min(viewWidth / frameWidth, viewHeight / frameHeight);
  const displayedWidth = frameWidth * displayScale;
  const displayedHeight = frameHeight * displayScale;
  return {
    left: (viewWidth - displayedWidth) / 2,
    top: (viewHeight - displayedHeight) / 2,
    width: displayedWidth,
    height: displayedHeight,
  };
}

/** Punto tocado en la vista → fracciones del fotograma (pueden salir de 0-1 si se toca el borde negro). */
export function viewPointToFrameFractions(
  viewX: number,
  viewY: number,
  frameRectangle: ViewRectangle,
): { xFraction: number; yFraction: number } {
  return {
    xFraction: (viewX - frameRectangle.left) / frameRectangle.width,
    yFraction: (viewY - frameRectangle.top) / frameRectangle.height,
  };
}

/** Rectángulo de la zona en la vista, para dibujarlo encima de la imagen. */
export function regionToViewRectangle(region: MeasurementRegion, frameRectangle: ViewRectangle): ViewRectangle {
  return {
    left: frameRectangle.left + (region.centerXFraction - region.sizeFraction / 2) * frameRectangle.width,
    top: frameRectangle.top + (region.centerYFraction - region.sizeFraction / 2) * frameRectangle.height,
    width: region.sizeFraction * frameRectangle.width,
    height: region.sizeFraction * frameRectangle.height,
  };
}
