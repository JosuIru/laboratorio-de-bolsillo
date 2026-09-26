/**
 * Detección de estrellas en una imagen de un canal (luminancia).
 *
 *  1. Fondo y ruido por celdas («mesh», como SExtractor): en cada celda, la mediana recortada de
 *     una muestra de píxeles (las estrellas ocupan pocos píxeles y no la mueven) y el ruido por la
 *     MAD. Se suaviza la malla con una mediana 3×3 y se interpola bilinealmente.
 *  2. Filtro adaptado: un desenfoque gaussiano (σ ≈ el de una estrella) sube la relación señal/
 *     ruido de las fuentes puntuales y aplana el ruido de píxel a píxel.
 *  3. Candidatas: máximos locales 3×3 de la imagen suavizada que superan el fondo en
 *     `thresholdSigmas` veces el ruido (medido también en la suavizada).
 *  4. Píxeles calientes: una estrella, borrosa por el objetivo, reparte luz a sus vecinos; un
 *     píxel caliente o un impacto no. Se descartan los picos cuyos vecinos tienen mucho menos
 *     exceso que el píxel central.
 *     También se descartan las detecciones muy alargadas (el rastro de un avión o un satélite
 *     daría una hilera de «estrellas»), por los momentos de segundo orden.
 *  5. Centroide subpíxel con ventana gaussiana iterativa (como XWIN de SExtractor): converge al
 *     centro verdadero de un perfil simétrico y el ruido del fondo apenas lo arrastra hacia el
 *     centro de la ventana, al contrario que el centroide simple.
 *
 * Convenio de coordenadas de `grayImage`: el centro del píxel (columna, fila) está en (x, y).
 * Módulo puro: sin React ni React Native.
 */
import { gaussianBlurGray, type GrayImage } from './grayImage';

export interface DetectedStar {
  /** Centroide subpíxel. */
  x: number;
  y: number;
  /** Suma del exceso sobre el fondo en la apertura (niveles × píxel). */
  flux: number;
  /** Exceso del píxel más brillante sobre el fondo. */
  peakExcess: number;
  /** Relación señal/ruido de la apertura. */
  signalToNoise: number;
}

export interface BackgroundMesh {
  cellSize: number;
  columnCount: number;
  rowCount: number;
  /** Nivel de fondo de cada celda (fila a fila). */
  levels: Float32Array;
  /** Ruido (σ) de cada celda. */
  noises: Float32Array;
}

export interface StarDetectionOptions {
  /** Lado de las celdas del fondo, en píxeles. */
  backgroundCellSize: number;
  /** σ del filtro adaptado; ~ el σ de una estrella en la imagen. */
  matchedFilterSigmaPixels: number;
  /** Umbral de detección sobre el fondo, en σ del ruido de la imagen suavizada. */
  thresholdSigmas: number;
  /** Mínimo exceso medio de los 4 vecinos respecto al del pico (0-1) para no ser un píxel caliente. */
  minimumNeighbourRatio: number;
  /** Máxima razón entre el eje largo y el corto de la mancha (1 = redonda). */
  maximumElongation: number;
  /** Radio de la apertura de flujo y de la ventana del centroide. */
  apertureRadiusPixels: number;
  /** σ de la ventana gaussiana del centroide. */
  centroidWindowSigmaPixels: number;
  /** Distancia mínima entre dos estrellas (se queda la más brillante). */
  minimumSeparationPixels: number;
  maximumStarCount: number;
}

export const defaultStarDetectionOptions: StarDetectionOptions = {
  backgroundCellSize: 32,
  matchedFilterSigmaPixels: 1,
  thresholdSigmas: 5,
  minimumNeighbourRatio: 0.2,
  maximumElongation: 2.5,
  apertureRadiusPixels: 3,
  centroidWindowSigmaPixels: 1.5,
  minimumSeparationPixels: 2.5,
  maximumStarCount: 3000,
};

/** Máximo de muestras por celda al estimar el fondo. */
const maximumSamplesPerCell = 256;
/** MAD → σ para ruido gaussiano. */
const madToSigma = 1.4826;

function medianOfSorted(sortedValues: readonly number[]): number {
  const middleIndex = sortedValues.length >> 1;
  return sortedValues.length % 2 === 1
    ? sortedValues[middleIndex]!
    : (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
}

/** Mediana y σ (por MAD) con dos rondas de recorte a 3σ por arriba (las estrellas solo suman). */
export function robustLevelAndNoise(sampleValues: number[]): { level: number; noise: number } {
  if (sampleValues.length === 0) return { level: 0, noise: 0 };
  let keptValues = sampleValues.slice().sort((first, second) => first - second);
  let level = medianOfSorted(keptValues);
  let noise = 0;
  for (let clippingRound = 0; clippingRound < 3; clippingRound++) {
    const absoluteDeviations = keptValues.map((value) => Math.abs(value - level)).sort((first, second) => first - second);
    noise = madToSigma * medianOfSorted(absoluteDeviations);
    const upperLimit = level + 3 * Math.max(noise, 0.5);
    const lowerLimit = level - 5 * Math.max(noise, 0.5);
    const clippedValues = keptValues.filter((value) => value <= upperLimit && value >= lowerLimit);
    if (clippedValues.length === keptValues.length || clippedValues.length < 8) break;
    keptValues = clippedValues;
    level = medianOfSorted(keptValues);
  }
  // Con niveles enteros (JPEG) y poco ruido la MAD puede salir 0: se usa la desviación típica.
  if (noise === 0 && keptValues.length > 1) {
    let squaredSum = 0;
    for (const value of keptValues) squaredSum += (value - level) ** 2;
    noise = Math.sqrt(squaredSum / (keptValues.length - 1));
  }
  return { level, noise };
}

function medianFilterMesh(values: Float32Array, columnCount: number, rowCount: number): Float32Array {
  const filteredValues = new Float32Array(values.length);
  const neighbourValues: number[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      neighbourValues.length = 0;
      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        const neighbourRow = rowIndex + rowOffset;
        if (neighbourRow < 0 || neighbourRow >= rowCount) continue;
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
          const neighbourColumn = columnIndex + columnOffset;
          if (neighbourColumn < 0 || neighbourColumn >= columnCount) continue;
          neighbourValues.push(values[neighbourRow * columnCount + neighbourColumn]!);
        }
      }
      neighbourValues.sort((first, second) => first - second);
      filteredValues[rowIndex * columnCount + columnIndex] = medianOfSorted(neighbourValues);
    }
  }
  return filteredValues;
}

/**
 * Fondo y ruido por celdas de `cellSize` píxeles. Con `shouldMedianFilter`, la malla se suaviza
 * con una mediana 3×3 (quita celdas sueltas con una estrella brillante, pero aplana algo un
 * gradiente en los bordes).
 */
export function estimateBackgroundMesh(image: GrayImage, cellSize: number, shouldMedianFilter = true): BackgroundMesh {
  const { width, height, values } = image;
  const columnCount = Math.max(1, Math.round(width / cellSize));
  const rowCount = Math.max(1, Math.round(height / cellSize));
  const levels = new Float32Array(columnCount * rowCount);
  const noises = new Float32Array(columnCount * rowCount);
  const cellWidth = width / columnCount;
  const cellHeight = height / rowCount;
  const sampleValues: number[] = [];
  for (let meshRow = 0; meshRow < rowCount; meshRow++) {
    const firstRow = Math.floor(meshRow * cellHeight);
    const lastRow = Math.min(height, Math.floor((meshRow + 1) * cellHeight));
    for (let meshColumn = 0; meshColumn < columnCount; meshColumn++) {
      const firstColumn = Math.floor(meshColumn * cellWidth);
      const lastColumn = Math.min(width, Math.floor((meshColumn + 1) * cellWidth));
      const cellPixelCount = (lastRow - firstRow) * (lastColumn - firstColumn);
      const sampleStride = Math.max(1, Math.floor(Math.sqrt(cellPixelCount / maximumSamplesPerCell)));
      sampleValues.length = 0;
      for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex += sampleStride) {
        for (let columnIndex = firstColumn; columnIndex < lastColumn; columnIndex += sampleStride) {
          sampleValues.push(values[rowIndex * width + columnIndex]!);
        }
      }
      const { level, noise } = robustLevelAndNoise(sampleValues);
      levels[meshRow * columnCount + meshColumn] = level;
      noises[meshRow * columnCount + meshColumn] = noise;
    }
  }
  return {
    cellSize,
    columnCount,
    rowCount,
    levels: shouldMedianFilter ? medianFilterMesh(levels, columnCount, rowCount) : levels,
    noises: shouldMedianFilter ? medianFilterMesh(noises, columnCount, rowCount) : noises,
  };
}

/** Valor de la malla interpolado en (x, y) de la imagen de `width`×`height`. */
export function sampleMesh(mesh: BackgroundMesh, meshValues: Float32Array, width: number, height: number, positionX: number, positionY: number): number {
  const { columnCount, rowCount } = mesh;
  // Centros de celda en ((i + 0,5)·ancho/columnas − 0,5, …).
  const meshX = Math.min(columnCount - 1, Math.max(0, ((positionX + 0.5) * columnCount) / width - 0.5));
  const meshY = Math.min(rowCount - 1, Math.max(0, ((positionY + 0.5) * rowCount) / height - 0.5));
  const leftColumn = Math.min(columnCount - 1, Math.floor(meshX));
  const topRow = Math.min(rowCount - 1, Math.floor(meshY));
  const rightColumn = Math.min(columnCount - 1, leftColumn + 1);
  const bottomRow = Math.min(rowCount - 1, topRow + 1);
  const horizontalWeight = meshX - leftColumn;
  const verticalWeight = meshY - topRow;
  const topValue =
    meshValues[topRow * columnCount + leftColumn]! * (1 - horizontalWeight) +
    meshValues[topRow * columnCount + rightColumn]! * horizontalWeight;
  const bottomValue =
    meshValues[bottomRow * columnCount + leftColumn]! * (1 - horizontalWeight) +
    meshValues[bottomRow * columnCount + rightColumn]! * horizontalWeight;
  return topValue * (1 - verticalWeight) + bottomValue * verticalWeight;
}

/** Imagen completa del fondo interpolado de la malla. */
export function backgroundImageFromMesh(mesh: BackgroundMesh, width: number, height: number): GrayImage {
  const values = new Float32Array(width * height);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      values[rowIndex * width + columnIndex] = sampleMesh(mesh, mesh.levels, width, height, columnIndex, rowIndex);
    }
  }
  return { width, height, values };
}

/**
 * Centroide con ventana gaussiana iterativa: x ← x + 2·Σ G·I·(xᵢ − x) / Σ G·I, con I el exceso
 * sobre el fondo. Devuelve null si no converge dentro de la ventana.
 */
function windowedCentroid(
  image: GrayImage,
  backgroundLevel: number,
  startX: number,
  startY: number,
  windowRadius: number,
  windowSigma: number,
): { x: number; y: number } | null {
  const { width, height, values } = image;
  const inverseTwoSigmaSquared = 1 / (2 * windowSigma * windowSigma);
  let centerX = startX;
  let centerY = startY;
  for (let iteration = 0; iteration < 12; iteration++) {
    const firstColumn = Math.max(0, Math.round(centerX) - windowRadius);
    const lastColumn = Math.min(width - 1, Math.round(centerX) + windowRadius);
    const firstRow = Math.max(0, Math.round(centerY) - windowRadius);
    const lastRow = Math.min(height - 1, Math.round(centerY) + windowRadius);
    let weightSum = 0;
    let weightedOffsetX = 0;
    let weightedOffsetY = 0;
    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
      const offsetY = rowIndex - centerY;
      for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex++) {
        const offsetX = columnIndex - centerX;
        const windowWeight = Math.exp(-(offsetX * offsetX + offsetY * offsetY) * inverseTwoSigmaSquared);
        const weight = windowWeight * (values[rowIndex * width + columnIndex]! - backgroundLevel);
        weightSum += weight;
        weightedOffsetX += weight * offsetX;
        weightedOffsetY += weight * offsetY;
      }
    }
    if (weightSum <= 0) return null;
    const stepX = (2 * weightedOffsetX) / weightSum;
    const stepY = (2 * weightedOffsetY) / weightSum;
    centerX += stepX;
    centerY += stepY;
    if (Math.abs(centerX - startX) > windowRadius || Math.abs(centerY - startY) > windowRadius) return null;
    if (stepX * stepX + stepY * stepY < 1e-6) break;
  }
  return { x: centerX, y: centerY };
}

/** Detecta estrellas; devuelve de más a menos brillante. */
export function detectStars(image: GrayImage, detectionOptions: Partial<StarDetectionOptions> = {}): DetectedStar[] {
  const options = { ...defaultStarDetectionOptions, ...detectionOptions };
  const { width, height, values } = image;
  const apertureRadius = options.apertureRadiusPixels;
  const borderMargin = apertureRadius + 1;
  if (width <= 2 * borderMargin || height <= 2 * borderMargin) return [];

  const mesh = estimateBackgroundMesh(image, options.backgroundCellSize);
  const smoothedImage = gaussianBlurGray(image, options.matchedFilterSigmaPixels);
  const smoothedMesh = estimateBackgroundMesh(smoothedImage, options.backgroundCellSize);
  const smoothedValues = smoothedImage.values;

  const candidateStars: DetectedStar[] = [];
  for (let rowIndex = borderMargin; rowIndex < height - borderMargin; rowIndex++) {
    // La malla varía despacio: se interpola una vez por píxel solo cuando hace falta.
    for (let columnIndex = borderMargin; columnIndex < width - borderMargin; columnIndex++) {
      const pixelIndex = rowIndex * width + columnIndex;
      const smoothedValue = smoothedValues[pixelIndex]!;
      // Máximo local: estrictamente mayor que los vecinos ya recorridos, mayor o igual que el resto
      // (en una meseta saturada se queda un solo píxel).
      if (
        smoothedValue <= smoothedValues[pixelIndex - width - 1]! ||
        smoothedValue <= smoothedValues[pixelIndex - width]! ||
        smoothedValue <= smoothedValues[pixelIndex - width + 1]! ||
        smoothedValue <= smoothedValues[pixelIndex - 1]! ||
        smoothedValue < smoothedValues[pixelIndex + 1]! ||
        smoothedValue < smoothedValues[pixelIndex + width - 1]! ||
        smoothedValue < smoothedValues[pixelIndex + width]! ||
        smoothedValue < smoothedValues[pixelIndex + width + 1]!
      ) {
        continue;
      }
      const smoothedBackground = sampleMesh(smoothedMesh, smoothedMesh.levels, width, height, columnIndex, rowIndex);
      const smoothedNoise = Math.max(0.05, sampleMesh(smoothedMesh, smoothedMesh.noises, width, height, columnIndex, rowIndex));
      if (smoothedValue - smoothedBackground < options.thresholdSigmas * smoothedNoise) continue;

      const backgroundLevel = sampleMesh(mesh, mesh.levels, width, height, columnIndex, rowIndex);
      const pixelNoise = Math.max(0.1, sampleMesh(mesh, mesh.noises, width, height, columnIndex, rowIndex));
      // El pico en la imagen original puede estar en un vecino del de la suavizada.
      let peakIndex = pixelIndex;
      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
          const neighbourIndex = pixelIndex + rowOffset * width + columnOffset;
          if (values[neighbourIndex]! > values[peakIndex]!) peakIndex = neighbourIndex;
        }
      }
      const peakExcess = values[peakIndex]! - backgroundLevel;
      if (peakExcess <= 0) continue;
      const neighbourExcessMean =
        (values[peakIndex - 1]! + values[peakIndex + 1]! + values[peakIndex - width]! + values[peakIndex + width]!) / 4 -
        backgroundLevel;
      if (neighbourExcessMean < options.minimumNeighbourRatio * peakExcess) continue;

      const peakColumn = peakIndex % width;
      const peakRow = (peakIndex - peakColumn) / width;
      const centroid = windowedCentroid(image, backgroundLevel, peakColumn, peakRow, apertureRadius + 1, options.centroidWindowSigmaPixels);
      if (!centroid) continue;

      let apertureFlux = 0;
      let aperturePixelCount = 0;
      // Momentos de segundo orden del exceso positivo, respecto al pico.
      let momentWeightSum = 0;
      let momentXX = 0;
      let momentYY = 0;
      let momentXY = 0;
      const radiusSquared = apertureRadius * apertureRadius;
      for (let rowOffset = -apertureRadius; rowOffset <= apertureRadius; rowOffset++) {
        for (let columnOffset = -apertureRadius; columnOffset <= apertureRadius; columnOffset++) {
          if (rowOffset * rowOffset + columnOffset * columnOffset > radiusSquared) continue;
          const pixelExcess = values[(peakRow + rowOffset) * width + peakColumn + columnOffset]! - backgroundLevel;
          apertureFlux += pixelExcess;
          aperturePixelCount++;
          if (pixelExcess > 2 * pixelNoise) {
            momentWeightSum += pixelExcess;
            momentXX += pixelExcess * columnOffset * columnOffset;
            momentYY += pixelExcess * rowOffset * rowOffset;
            momentXY += pixelExcess * columnOffset * rowOffset;
          }
        }
      }
      if (apertureFlux <= 0) continue;
      if (momentWeightSum > 0) {
        // Autovalores de la matriz de momentos (+ ¼ px² del propio píxel, para que un píxel solo no divida por 0).
        const varianceX = momentXX / momentWeightSum + 0.25;
        const varianceY = momentYY / momentWeightSum + 0.25;
        const covarianceXY = momentXY / momentWeightSum;
        const halfTrace = (varianceX + varianceY) / 2;
        const eigenvalueSpread = Math.sqrt(((varianceX - varianceY) / 2) ** 2 + covarianceXY * covarianceXY);
        const largerEigenvalue = halfTrace + eigenvalueSpread;
        const smallerEigenvalue = Math.max(1e-6, halfTrace - eigenvalueSpread);
        if (Math.sqrt(largerEigenvalue / smallerEigenvalue) > options.maximumElongation) continue;
      }
      candidateStars.push({
        x: centroid.x,
        y: centroid.y,
        flux: apertureFlux,
        peakExcess,
        signalToNoise: apertureFlux / (pixelNoise * Math.sqrt(aperturePixelCount)),
      });
    }
  }

  candidateStars.sort((first, second) => second.flux - first.flux);
  // Separación mínima: rejilla de celdas del tamaño de la separación para no comparar todas con todas.
  const separationSquared = options.minimumSeparationPixels ** 2;
  const gridCellSize = Math.max(1, options.minimumSeparationPixels);
  const occupiedCells = new Map<number, DetectedStar[]>();
  const gridColumnCount = Math.ceil(width / gridCellSize) + 2;
  const keptStars: DetectedStar[] = [];
  for (const candidateStar of candidateStars) {
    if (keptStars.length >= options.maximumStarCount) break;
    const cellColumn = Math.floor(candidateStar.x / gridCellSize) + 1;
    const cellRow = Math.floor(candidateStar.y / gridCellSize) + 1;
    let isTooClose = false;
    for (let rowOffset = -1; rowOffset <= 1 && !isTooClose; rowOffset++) {
      for (let columnOffset = -1; columnOffset <= 1 && !isTooClose; columnOffset++) {
        const nearbyStars = occupiedCells.get((cellRow + rowOffset) * gridColumnCount + cellColumn + columnOffset);
        if (!nearbyStars) continue;
        for (const nearbyStar of nearbyStars) {
          if ((nearbyStar.x - candidateStar.x) ** 2 + (nearbyStar.y - candidateStar.y) ** 2 < separationSquared) {
            isTooClose = true;
            break;
          }
        }
      }
    }
    if (isTooClose) continue;
    keptStars.push(candidateStar);
    const cellKey = cellRow * gridColumnCount + cellColumn;
    const cellStars = occupiedCells.get(cellKey);
    if (cellStars) cellStars.push(candidateStar);
    else occupiedCells.set(cellKey, [candidateStar]);
  }
  return keptStars;
}

/** Ruido típico (mediana de las celdas) de una imagen, en niveles. */
export function typicalBackgroundNoise(image: GrayImage, cellSize = defaultStarDetectionOptions.backgroundCellSize): number {
  const mesh = estimateBackgroundMesh(image, cellSize);
  const sortedNoises = Array.from(mesh.noises).sort((first, second) => first - second);
  return medianOfSorted(sortedNoises);
}
