/**
 * Detección de partículas ionizantes con la cámara tapada (como las apps DECO o CRAYFIS).
 *
 * Con la lente tapada, el sensor ve negro salvo el ruido térmico y electrónico. Una partícula
 * cargada que atraviesa el silicio (un muón de los rayos cósmicos, un electrón arrancado por un
 * rayo gamma de la radiactividad natural) libera carga y deja en ese fotograma un píxel o una
 * traza brillante. Aquí:
 *
 * 1. `sampleDarkLevel` estima el nivel de negro del fotograma (se sigue en cada fotograma: el
 *    umbral se adapta cuando el sensor se calienta).
 * 2. `findSeedPixels` busca los píxeles que superan el umbral y no están en la máscara de píxeles
 *    calientes medida al calibrar.
 * 3. `groupSeedsIntoClusters` junta cada semilla con sus vecinos por encima de un umbral más bajo.
 * 4. `describeCluster` y `classifyParticleShape` miden la forma: punto, gusano o traza recta.
 * 5. `copyBrightnessThumbnail` recorta una miniatura para la galería.
 *
 * `detectParticleEventsInFrame` lo encadena todo. El brillo de un píxel es el máximo de sus tres
 * canales: tras el «demosaico», el impacto en un solo fotodiodo del filtro de Bayer puede quedar
 * sobre todo en un canal, y el máximo lo conserva mejor que la luminancia ponderada.
 *
 * Módulo puro: sin React ni React Native. Las funciones son worklets (se ejecutan en el hilo de la
 * cámara). Los índices de píxel son `fila × ancho + columna`, sin contar el relleno de cada fila.
 */

export type ParticleShape = 'spot' | 'worm' | 'track';

/** Geometría de los píxeles de un fotograma RGB, RGBA o BGRA de 8 bits. */
export interface FramePixelLayout {
  frameWidth: number;
  frameHeight: number;
  bytesPerRow: number;
  /** 3 (RGB) o 4 (RGBA/BGRA); el orden de canales no importa porque se toma el máximo. */
  bytesPerPixel: number;
}

export interface ParticleCluster {
  pixelIndices: number[];
  brightnessValues: number[];
  /** Se cortó al llegar al máximo de píxeles: demasiado grande para ser una partícula. */
  isTruncated: boolean;
}

export interface ClusterFeatures {
  pixelCount: number;
  peakBrightness: number;
  peakPixelIndex: number;
  /** Suma del brillo por encima del nivel de negro: proporcional a la carga depositada. */
  totalExcessBrightness: number;
  /** Centroide ponderado por el exceso de brillo, en píxeles del fotograma. */
  centerX: number;
  centerY: number;
  /** Extensión a lo largo del eje principal (píxeles, contando los extremos). */
  lengthPixels: number;
  /** Extensión en la dirección perpendicular. */
  widthPixels: number;
  /** Dispersión cuadrática media perpendicular al eje principal: casi 0 en una recta. */
  perpendicularRmsPixels: number;
  boundingWidth: number;
  boundingHeight: number;
}

export interface DetectedParticleEvent extends ClusterFeatures {
  shape: ParticleShape;
  /** Brillo (0-255) de la miniatura cuadrada, fila a fila. */
  thumbnailPixels: Uint8Array;
  thumbnailSide: number;
}

export interface ParticleDetectionOptions {
  /** Cuánto por encima del nivel de negro tiene que estar una semilla (niveles de 0-255). */
  thresholdOffset: number;
  /** Fracción de `thresholdOffset` para añadir vecinos a un suceso ya encontrado. */
  growThresholdFraction: number;
  /** Semillas máximas por fotograma: más significa que entra luz o que el umbral es bajo. */
  maximumSeedCount: number;
  /** Píxeles máximos de un suceso: más grande es luz, no una partícula. */
  maximumClusterPixels: number;
  /** Sucesos máximos por fotograma de los que se hace miniatura. */
  maximumEventsPerFrame: number;
  /** Nivel de negro por encima del cual se considera que entra luz y se ignora el fotograma. */
  lightLeakDarkLevel: number;
  /** Salto de píxeles al estimar el nivel de negro. */
  darkLevelSampleStride: number;
}

export const defaultParticleDetectionOptions: ParticleDetectionOptions = {
  thresholdOffset: 20,
  growThresholdFraction: 0.5,
  maximumSeedCount: 400,
  maximumClusterPixels: 600,
  maximumEventsPerFrame: 6,
  lightLeakDarkLevel: 40,
  darkLevelSampleStride: 8,
};

export interface FrameDetectionResult {
  darkLevel: number;
  /** El fotograma no se analiza: entra luz (nivel de negro alto) o hay demasiadas semillas. */
  isLightLeak: boolean;
  isOverflowing: boolean;
  /** Sucesos encontrados (incluidos los que no caben en `events`). */
  clusterCount: number;
  /** Sucesos descartados por demasiado grandes. */
  oversizedClusterCount: number;
  events: DetectedParticleEvent[];
}

/** Clasificación por forma, en píxeles del fotograma analizado. */
export interface ShapeClassificationOptions {
  /** Hasta esta longitud es un punto. */
  spotMaximumLength: number;
  /** Desde esta longitud puede ser una traza recta. */
  trackMinimumLength: number;
  /** Dispersión perpendicular máxima de una traza recta. */
  trackMaximumPerpendicularRms: number;
  /** Relación mínima largo/ancho de una traza recta. */
  trackMinimumAspectRatio: number;
}

export const defaultShapeClassificationOptions: ShapeClassificationOptions = {
  spotMaximumLength: 3,
  trackMinimumLength: 6,
  trackMaximumPerpendicularRms: 1,
  trackMinimumAspectRatio: 3,
};

/** Media del brillo (máximo de canales) en una rejilla de muestras: el nivel de negro. */
export function sampleDarkLevel(pixels: Uint8Array, layout: FramePixelLayout, sampleStride: number): number {
  'worklet';
  const { frameWidth, frameHeight, bytesPerRow, bytesPerPixel } = layout;
  let brightnessSum = 0;
  let sampleCount = 0;
  for (let rowIndex = 0; rowIndex < frameHeight; rowIndex += sampleStride) {
    const rowOffset = rowIndex * bytesPerRow;
    for (let columnIndex = 0; columnIndex < frameWidth; columnIndex += sampleStride) {
      const pixelOffset = rowOffset + columnIndex * bytesPerPixel;
      const redValue = pixels[pixelOffset]!;
      const greenValue = pixels[pixelOffset + 1]!;
      const blueValue = pixels[pixelOffset + 2]!;
      brightnessSum +=
        redValue > greenValue ? (redValue > blueValue ? redValue : blueValue) : greenValue > blueValue ? greenValue : blueValue;
      sampleCount++;
    }
  }
  return sampleCount === 0 ? 0 : brightnessSum / sampleCount;
}

/** Brillo (máximo de los tres canales) del píxel `pixelIndex`. */
export function readPixelBrightness(pixels: Uint8Array, layout: FramePixelLayout, pixelIndex: number): number {
  'worklet';
  const rowIndex = Math.floor(pixelIndex / layout.frameWidth);
  const columnIndex = pixelIndex - rowIndex * layout.frameWidth;
  const pixelOffset = rowIndex * layout.bytesPerRow + columnIndex * layout.bytesPerPixel;
  const redValue = pixels[pixelOffset]!;
  const greenValue = pixels[pixelOffset + 1]!;
  const blueValue = pixels[pixelOffset + 2]!;
  return redValue > greenValue ? (redValue > blueValue ? redValue : blueValue) : greenValue > blueValue ? greenValue : blueValue;
}

/** Suma a `histogram` (256 casillas) el brillo de una rejilla de muestras del fotograma. */
export function accumulateBrightnessHistogram(
  pixels: Uint8Array,
  layout: FramePixelLayout,
  sampleStride: number,
  histogram: Uint32Array | number[],
): void {
  'worklet';
  const { frameWidth, frameHeight, bytesPerRow, bytesPerPixel } = layout;
  for (let rowIndex = 0; rowIndex < frameHeight; rowIndex += sampleStride) {
    const rowOffset = rowIndex * bytesPerRow;
    for (let columnIndex = 0; columnIndex < frameWidth; columnIndex += sampleStride) {
      const pixelOffset = rowOffset + columnIndex * bytesPerPixel;
      const redValue = pixels[pixelOffset]!;
      const greenValue = pixels[pixelOffset + 1]!;
      const blueValue = pixels[pixelOffset + 2]!;
      const brightness =
        redValue > greenValue ? (redValue > blueValue ? redValue : blueValue) : greenValue > blueValue ? greenValue : blueValue;
      histogram[brightness] = (histogram[brightness] ?? 0) + 1;
    }
  }
}

/** Búsqueda binaria en una lista ordenada de índices de píxeles calientes. */
export function isHotPixel(sortedHotPixelIndices: ArrayLike<number>, pixelIndex: number): boolean {
  'worklet';
  let lowerBound = 0;
  let upperBound = sortedHotPixelIndices.length - 1;
  while (lowerBound <= upperBound) {
    const middleIndex = (lowerBound + upperBound) >> 1;
    const middleValue = sortedHotPixelIndices[middleIndex]!;
    if (middleValue === pixelIndex) return true;
    if (middleValue < pixelIndex) lowerBound = middleIndex + 1;
    else upperBound = middleIndex - 1;
  }
  return false;
}

export interface SeedSearchResult {
  seedIndices: number[];
  /** Se llegó a `maximumSeedCount`: la lista está incompleta. */
  isOverflowing: boolean;
}

/**
 * Píxeles con algún canal por encima de `seedThreshold` que no están en la máscara. El bucle
 * compara canal a canal sin calcular el máximo: es el recorrido completo del fotograma y tiene
 * que ser lo más ligero posible.
 */
export function findSeedPixels(
  pixels: Uint8Array,
  layout: FramePixelLayout,
  seedThreshold: number,
  sortedHotPixelIndices: ArrayLike<number>,
  maximumSeedCount: number,
): SeedSearchResult {
  'worklet';
  const { frameWidth, frameHeight, bytesPerRow, bytesPerPixel } = layout;
  const seedIndices: number[] = [];
  for (let rowIndex = 0; rowIndex < frameHeight; rowIndex++) {
    const rowOffset = rowIndex * bytesPerRow;
    const rowEndOffset = rowOffset + frameWidth * bytesPerPixel;
    for (let pixelOffset = rowOffset; pixelOffset < rowEndOffset; pixelOffset += bytesPerPixel) {
      if (
        pixels[pixelOffset]! > seedThreshold ||
        pixels[pixelOffset + 1]! > seedThreshold ||
        pixels[pixelOffset + 2]! > seedThreshold
      ) {
        const pixelIndex = rowIndex * frameWidth + (pixelOffset - rowOffset) / bytesPerPixel;
        if (isHotPixel(sortedHotPixelIndices, pixelIndex)) continue;
        seedIndices.push(pixelIndex);
        if (seedIndices.length >= maximumSeedCount) return { seedIndices, isOverflowing: true };
      }
    }
  }
  return { seedIndices, isOverflowing: false };
}

/**
 * Agrupa las semillas en sucesos: desde cada semilla se añaden los vecinos (8-conectividad) con
 * brillo por encima de `growThreshold` que no sean píxeles calientes. Dos semillas contiguas
 * acaban en el mismo suceso.
 */
export function groupSeedsIntoClusters(
  pixels: Uint8Array,
  layout: FramePixelLayout,
  seedIndices: readonly number[],
  growThreshold: number,
  sortedHotPixelIndices: ArrayLike<number>,
  maximumClusterPixels: number,
): ParticleCluster[] {
  'worklet';
  const { frameWidth, frameHeight } = layout;
  const visitedPixelIndices = new Set<number>();
  const clusters: ParticleCluster[] = [];
  for (const seedIndex of seedIndices) {
    if (visitedPixelIndices.has(seedIndex)) continue;
    visitedPixelIndices.add(seedIndex);
    const pixelIndices: number[] = [];
    const brightnessValues: number[] = [];
    const pendingPixelIndices = [seedIndex];
    let isTruncated = false;
    while (pendingPixelIndices.length > 0) {
      const pixelIndex = pendingPixelIndices.pop()!;
      // Pasado el tope ya no se guardan píxeles, pero se sigue inundando para marcar visitada toda
      // la mancha: si no, otra semilla dentro de ella daría un suceso «nuevo» más pequeño.
      if (!isTruncated) {
        pixelIndices.push(pixelIndex);
        brightnessValues.push(readPixelBrightness(pixels, layout, pixelIndex));
        if (pixelIndices.length >= maximumClusterPixels) isTruncated = true;
      }
      const rowIndex = Math.floor(pixelIndex / frameWidth);
      const columnIndex = pixelIndex - rowIndex * frameWidth;
      for (let rowStep = -1; rowStep <= 1; rowStep++) {
        const neighbourRow = rowIndex + rowStep;
        if (neighbourRow < 0 || neighbourRow >= frameHeight) continue;
        for (let columnStep = -1; columnStep <= 1; columnStep++) {
          const neighbourColumn = columnIndex + columnStep;
          if ((rowStep === 0 && columnStep === 0) || neighbourColumn < 0 || neighbourColumn >= frameWidth) continue;
          const neighbourIndex = neighbourRow * frameWidth + neighbourColumn;
          if (visitedPixelIndices.has(neighbourIndex)) continue;
          if (readPixelBrightness(pixels, layout, neighbourIndex) <= growThreshold) continue;
          if (isHotPixel(sortedHotPixelIndices, neighbourIndex)) continue;
          visitedPixelIndices.add(neighbourIndex);
          pendingPixelIndices.push(neighbourIndex);
        }
      }
    }
    clusters.push({ pixelIndices, brightnessValues, isTruncated });
  }
  return clusters;
}

/** Tamaño, intensidad y forma de un suceso (momentos de segundo orden de sus píxeles). */
export function describeCluster(cluster: ParticleCluster, frameWidth: number, darkLevel: number): ClusterFeatures {
  'worklet';
  const pixelCount = cluster.pixelIndices.length;
  let peakBrightness = -1;
  let peakPixelIndex = -1;
  let totalExcessBrightness = 0;
  let weightedXSum = 0;
  let weightedYSum = 0;
  let plainXSum = 0;
  let plainYSum = 0;
  let minimumX = Infinity;
  let maximumX = -Infinity;
  let minimumY = Infinity;
  let maximumY = -Infinity;
  const pixelXs: number[] = [];
  const pixelYs: number[] = [];
  for (let clusterPixel = 0; clusterPixel < pixelCount; clusterPixel++) {
    const pixelIndex = cluster.pixelIndices[clusterPixel]!;
    const brightness = cluster.brightnessValues[clusterPixel]!;
    const pixelY = Math.floor(pixelIndex / frameWidth);
    const pixelX = pixelIndex - pixelY * frameWidth;
    pixelXs.push(pixelX);
    pixelYs.push(pixelY);
    const excessBrightness = Math.max(0, brightness - darkLevel);
    totalExcessBrightness += excessBrightness;
    // Peso mínimo de 1 para que un píxel justo en el nivel de negro no anule el centroide.
    const centroidWeight = Math.max(1, excessBrightness);
    weightedXSum += pixelX * centroidWeight;
    weightedYSum += pixelY * centroidWeight;
    plainXSum += pixelX;
    plainYSum += pixelY;
    if (brightness > peakBrightness) {
      peakBrightness = brightness;
      peakPixelIndex = pixelIndex;
    }
    if (pixelX < minimumX) minimumX = pixelX;
    if (pixelX > maximumX) maximumX = pixelX;
    if (pixelY < minimumY) minimumY = pixelY;
    if (pixelY > maximumY) maximumY = pixelY;
  }
  let weightSum = 0;
  for (let clusterPixel = 0; clusterPixel < pixelCount; clusterPixel++) {
    weightSum += Math.max(1, cluster.brightnessValues[clusterPixel]! - darkLevel);
  }

  // Covarianza de las posiciones (sin ponderar: la forma, no dónde está la carga).
  const meanX = plainXSum / pixelCount;
  const meanY = plainYSum / pixelCount;
  let varianceXX = 0;
  let varianceYY = 0;
  let covarianceXY = 0;
  for (let clusterPixel = 0; clusterPixel < pixelCount; clusterPixel++) {
    const deltaX = pixelXs[clusterPixel]! - meanX;
    const deltaY = pixelYs[clusterPixel]! - meanY;
    varianceXX += deltaX * deltaX;
    varianceYY += deltaY * deltaY;
    covarianceXY += deltaX * deltaY;
  }
  varianceXX /= pixelCount;
  varianceYY /= pixelCount;
  covarianceXY /= pixelCount;
  const halfTrace = (varianceXX + varianceYY) / 2;
  const eigenSpread = Math.sqrt(((varianceXX - varianceYY) / 2) ** 2 + covarianceXY ** 2);
  const minorEigenvalue = Math.max(0, halfTrace - eigenSpread);
  const majorAxisAngle = 0.5 * Math.atan2(2 * covarianceXY, varianceXX - varianceYY);
  const majorAxisX = Math.cos(majorAxisAngle);
  const majorAxisY = Math.sin(majorAxisAngle);

  let minimumMajorProjection = Infinity;
  let maximumMajorProjection = -Infinity;
  let minimumMinorProjection = Infinity;
  let maximumMinorProjection = -Infinity;
  for (let clusterPixel = 0; clusterPixel < pixelCount; clusterPixel++) {
    const deltaX = pixelXs[clusterPixel]! - meanX;
    const deltaY = pixelYs[clusterPixel]! - meanY;
    const majorProjection = deltaX * majorAxisX + deltaY * majorAxisY;
    const minorProjection = -deltaX * majorAxisY + deltaY * majorAxisX;
    if (majorProjection < minimumMajorProjection) minimumMajorProjection = majorProjection;
    if (majorProjection > maximumMajorProjection) maximumMajorProjection = majorProjection;
    if (minorProjection < minimumMinorProjection) minimumMinorProjection = minorProjection;
    if (minorProjection > maximumMinorProjection) maximumMinorProjection = minorProjection;
  }

  return {
    pixelCount,
    peakBrightness,
    peakPixelIndex,
    totalExcessBrightness,
    centerX: weightedXSum / weightSum,
    centerY: weightedYSum / weightSum,
    lengthPixels: maximumMajorProjection - minimumMajorProjection + 1,
    widthPixels: maximumMinorProjection - minimumMinorProjection + 1,
    perpendicularRmsPixels: Math.sqrt(minorEigenvalue),
    boundingWidth: maximumX - minimumX + 1,
    boundingHeight: maximumY - minimumY + 1,
  };
}

/**
 * Punto, gusano o traza recta (la clasificación de DECO). Las trazas largas y rectas son la firma
 * típica de un muón que cruza el sensor inclinado; los gusanos, de electrones de baja energía que
 * van rebotando (por ejemplo, arrancados por rayos gamma); los puntos pueden ser cualquier cosa,
 * incluido un muón que cruza de frente o ruido térmico.
 */
export function classifyParticleShape(
  features: Pick<ClusterFeatures, 'lengthPixels' | 'widthPixels' | 'perpendicularRmsPixels'>,
  options: ShapeClassificationOptions = defaultShapeClassificationOptions,
): ParticleShape {
  'worklet';
  if (features.lengthPixels <= options.spotMaximumLength) return 'spot';
  if (
    features.lengthPixels >= options.trackMinimumLength &&
    features.perpendicularRmsPixels <= options.trackMaximumPerpendicularRms &&
    features.lengthPixels / Math.max(1, features.widthPixels) >= options.trackMinimumAspectRatio
  ) {
    return 'track';
  }
  return 'worm';
}

/** Lado de la miniatura: el suceso con un margen, entre 16 y 64 px y par. */
export function thumbnailSideForCluster(features: Pick<ClusterFeatures, 'boundingWidth' | 'boundingHeight'>): number {
  'worklet';
  const sideWithMargin = Math.max(features.boundingWidth, features.boundingHeight) + 8;
  const evenSide = Math.ceil(sideWithMargin / 2) * 2;
  return Math.min(64, Math.max(16, evenSide));
}

/** Brillo (0-255) de un cuadrado de lado `side` centrado en (`centerX`, `centerY`); fuera, 0. */
export function copyBrightnessThumbnail(
  pixels: Uint8Array,
  layout: FramePixelLayout,
  centerX: number,
  centerY: number,
  side: number,
): Uint8Array {
  'worklet';
  const thumbnailPixels = new Uint8Array(side * side);
  const leftColumn = Math.round(centerX) - side / 2;
  const topRow = Math.round(centerY) - side / 2;
  for (let thumbnailRow = 0; thumbnailRow < side; thumbnailRow++) {
    const frameRow = topRow + thumbnailRow;
    if (frameRow < 0 || frameRow >= layout.frameHeight) continue;
    for (let thumbnailColumn = 0; thumbnailColumn < side; thumbnailColumn++) {
      const frameColumn = leftColumn + thumbnailColumn;
      if (frameColumn < 0 || frameColumn >= layout.frameWidth) continue;
      thumbnailPixels[thumbnailRow * side + thumbnailColumn] = readPixelBrightness(
        pixels,
        layout,
        frameRow * layout.frameWidth + frameColumn,
      );
    }
  }
  return thumbnailPixels;
}

/**
 * Analiza un fotograma tomado con la cámara tapada: nivel de negro, semillas fuera de la máscara,
 * sucesos, forma y miniaturas. Si entra luz o hay demasiadas semillas, no devuelve sucesos.
 */
export function detectParticleEventsInFrame(
  pixels: Uint8Array,
  layout: FramePixelLayout,
  sortedHotPixelIndices: ArrayLike<number>,
  options: ParticleDetectionOptions,
  shapeOptions: ShapeClassificationOptions = defaultShapeClassificationOptions,
): FrameDetectionResult {
  'worklet';
  const darkLevel = sampleDarkLevel(pixels, layout, options.darkLevelSampleStride);
  const emptyResult: FrameDetectionResult = {
    darkLevel,
    isLightLeak: false,
    isOverflowing: false,
    clusterCount: 0,
    oversizedClusterCount: 0,
    events: [],
  };
  if (darkLevel > options.lightLeakDarkLevel) return { ...emptyResult, isLightLeak: true };

  const seedThreshold = darkLevel + options.thresholdOffset;
  const { seedIndices, isOverflowing } = findSeedPixels(
    pixels,
    layout,
    seedThreshold,
    sortedHotPixelIndices,
    options.maximumSeedCount,
  );
  if (isOverflowing) return { ...emptyResult, isOverflowing: true };
  if (seedIndices.length === 0) return emptyResult;

  const growThreshold = darkLevel + options.thresholdOffset * options.growThresholdFraction;
  const clusters = groupSeedsIntoClusters(
    pixels,
    layout,
    seedIndices,
    growThreshold,
    sortedHotPixelIndices,
    options.maximumClusterPixels,
  );
  const events: DetectedParticleEvent[] = [];
  let oversizedClusterCount = 0;
  for (const cluster of clusters) {
    if (cluster.isTruncated) {
      oversizedClusterCount++;
      continue;
    }
    if (events.length >= options.maximumEventsPerFrame) continue;
    const features = describeCluster(cluster, layout.frameWidth, darkLevel);
    const thumbnailSide = thumbnailSideForCluster(features);
    events.push({
      ...features,
      shape: classifyParticleShape(features, shapeOptions),
      thumbnailPixels: copyBrightnessThumbnail(pixels, layout, features.centerX, features.centerY, thumbnailSide),
      thumbnailSide,
    });
  }
  return {
    darkLevel,
    isLightLeak: false,
    isOverflowing: false,
    clusterCount: clusters.length - oversizedClusterCount,
    oversizedClusterCount,
    events,
  };
}
