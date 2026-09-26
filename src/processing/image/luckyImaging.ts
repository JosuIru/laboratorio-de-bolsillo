/**
 * Imagen afortunada («lucky imaging») para la Luna a través de unos prismáticos o un telescopio:
 * de decenas o cientos de fotogramas, la turbulencia deja unos pocos casi nítidos y deforma
 * cada uno de forma distinta y local (una zona se corre medio píxel a un lado y otra al otro).
 *
 *  1. Nitidez de cada fotograma: varianza del laplaciano en la zona del disco.
 *  2. Se queda el mejor X %.
 *  3. Alineado global con el más nítido (el alineador por pirámide de `burstSuperResolution`).
 *  4. Referencia = media de los alineados: borrosa, pero sin las deformaciones de ninguno.
 *  5. Alineado por puntos: rejilla de puntos sobre zonas con contraste, desplazamiento local de
 *     cada uno respecto a la referencia y un campo de desplazamientos suave interpolado entre ellos.
 *  6. Apilado con media recortada (sigma-clipping): se descartan muestras a más de κ·σ de la media
 *     (un avión, un píxel caliente, un fotograma movido).
 *  7. Realce por ondículas «à trous» (niveles de detalle con ganancias), alternativa a la máscara
 *     de enfoque de `lunarStacking`.
 *
 * Memoria acotada: los fotogramas se piden de uno en uno a una `FrameSource` (pueden leerse del
 * disco cada vez) y solo se acumulan sumas; se recorren hasta cuatro veces los seleccionados.
 * Todas las imágenes son cuadradas (`size`²) y de un canal (luminancia 0-255).
 *
 * Módulo puro: sin React ni React Native.
 */

import { createFrameAligner, type FrameOffset } from './burstSuperResolution';
import { convolveSeparable, gaussianBlurGray, type GrayImage, meanOfValues, percentileOfValues, sampleBilinear } from './grayImage';

export interface FrameSource {
  frameCount: number;
  /** Devuelve el fotograma pedido; puede decodificarlo cada vez para no tenerlos todos en memoria. */
  loadFrame: (frameIndex: number) => GrayImage;
}

export function frameSourceFromArray(frames: readonly GrayImage[]): FrameSource {
  return { frameCount: frames.length, loadFrame: (frameIndex) => frames[frameIndex]! };
}

export interface RegionOfInterest {
  centerX: number;
  centerY: number;
  radiusPixels: number;
}

// ---------------------------------------------------------------------------------------------
// 1-2. Nitidez y selección
// ---------------------------------------------------------------------------------------------

/** Lado de los bloques en que se mide la nitidez por separado. */
const sharpnessTileSize = 16;
/** Bloques más oscuros que esta fracción del más brillante (el cielo) no cuentan. */
const minimumTileBrightnessFraction = 0.2;

/**
 * Nitidez de un fotograma: varianza del laplaciano dividida por el brillo medio al cuadrado (para
 * que una nube fina no cambie el orden), medida por bloques de 16 px dentro de la región y
 * resumida con la mediana. Así un artefacto local (un avión, un píxel caliente) no convierte un
 * fotograma en el «más nítido». Se suaviza antes para que el ruido no cuente como detalle.
 */
export function measureLaplacianSharpness(
  image: GrayImage,
  regionOfInterest?: RegionOfInterest,
  smoothingSigmaPixels = 1,
): number {
  const smoothedImage = gaussianBlurGray(image, smoothingSigmaPixels);
  const { width, height, values } = smoothedImage;
  const squaredRadius = regionOfInterest ? regionOfInterest.radiusPixels ** 2 : Number.POSITIVE_INFINITY;
  const tileColumns = Math.max(1, Math.floor((width - 2) / sharpnessTileSize));
  const tileRows = Math.max(1, Math.floor((height - 2) / sharpnessTileSize));
  const tileLaplacianSums = new Float64Array(tileColumns * tileRows);
  const tileLaplacianSquaredSums = new Float64Array(tileColumns * tileRows);
  const tileBrightnessSums = new Float64Array(tileColumns * tileRows);
  const tileSampleCounts = new Uint32Array(tileColumns * tileRows);
  for (let rowIndex = 1; rowIndex < height - 1; rowIndex++) {
    const tileRow = Math.min(tileRows - 1, Math.floor((rowIndex - 1) / sharpnessTileSize));
    for (let columnIndex = 1; columnIndex < width - 1; columnIndex++) {
      if (regionOfInterest) {
        const deltaX = columnIndex - regionOfInterest.centerX;
        const deltaY = rowIndex - regionOfInterest.centerY;
        if (deltaX * deltaX + deltaY * deltaY > squaredRadius) continue;
      }
      const tileIndex = tileRow * tileColumns + Math.min(tileColumns - 1, Math.floor((columnIndex - 1) / sharpnessTileSize));
      const pixelIndex = rowIndex * width + columnIndex;
      const laplacian =
        values[pixelIndex - 1]! + values[pixelIndex + 1]! + values[pixelIndex - width]! + values[pixelIndex + width]! -
        4 * values[pixelIndex]!;
      tileLaplacianSums[tileIndex] = tileLaplacianSums[tileIndex]! + laplacian;
      tileLaplacianSquaredSums[tileIndex] = tileLaplacianSquaredSums[tileIndex]! + laplacian * laplacian;
      tileBrightnessSums[tileIndex] = tileBrightnessSums[tileIndex]! + values[pixelIndex]!;
      tileSampleCounts[tileIndex] = tileSampleCounts[tileIndex]! + 1;
    }
  }
  let brightestTileMean = 0;
  for (let tileIndex = 0; tileIndex < tileSampleCounts.length; tileIndex++) {
    const sampleCount = tileSampleCounts[tileIndex]!;
    if (sampleCount > 0) brightestTileMean = Math.max(brightestTileMean, tileBrightnessSums[tileIndex]! / sampleCount);
  }
  if (brightestTileMean <= 0) return 0;
  const tileScores: number[] = [];
  for (let tileIndex = 0; tileIndex < tileSampleCounts.length; tileIndex++) {
    const sampleCount = tileSampleCounts[tileIndex]!;
    // Bloques casi vacíos (borde de la región) o del cielo no dicen nada de la turbulencia.
    if (sampleCount < sharpnessTileSize * 2) continue;
    const tileMean = tileBrightnessSums[tileIndex]! / sampleCount;
    if (tileMean < minimumTileBrightnessFraction * brightestTileMean) continue;
    const laplacianVariance =
      tileLaplacianSquaredSums[tileIndex]! / sampleCount - (tileLaplacianSums[tileIndex]! / sampleCount) ** 2;
    tileScores.push(laplacianVariance / (tileMean * tileMean));
  }
  if (tileScores.length === 0) return 0;
  tileScores.sort((first, second) => first - second);
  return tileScores[Math.floor(tileScores.length / 2)]!;
}

/** Índices de la fracción `keptFraction` más nítida (al menos uno), de más a menos nítido. */
export function selectSharpestFrameIndices(sharpnessScores: readonly number[], keptFraction: number): number[] {
  const keptCount = Math.max(1, Math.min(sharpnessScores.length, Math.round(sharpnessScores.length * keptFraction)));
  return sharpnessScores
    .map((_score, frameIndex) => frameIndex)
    .sort((firstIndex, secondIndex) => sharpnessScores[secondIndex]! - sharpnessScores[firstIndex]!)
    .slice(0, keptCount);
}

// ---------------------------------------------------------------------------------------------
// 5. Alineado por puntos
// ---------------------------------------------------------------------------------------------

export interface AlignmentPoint {
  positionX: number;
  positionY: number;
  /** Menor autovalor del tensor de estructura por píxel: cuánto «agarre» tiene el parche en ambas direcciones. */
  trackability: number;
}

export interface LocalShift {
  positionX: number;
  positionY: number;
  /** Lo que en la referencia está en el punto aparece en el fotograma desplazado (shiftX, shiftY). */
  shiftX: number;
  shiftY: number;
}

interface PatchGradients {
  gradientX: Float32Array;
  gradientY: Float32Array;
  inverseHessian: [number, number, number];
}

function patchGradients(reference: GrayImage, centerX: number, centerY: number, patchRadius: number): PatchGradients | null {
  const patchSide = 2 * patchRadius + 1;
  const gradientX = new Float32Array(patchSide * patchSide);
  const gradientY = new Float32Array(patchSide * patchSide);
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  const { width, values } = reference;
  for (let patchRow = 0; patchRow < patchSide; patchRow++) {
    for (let patchColumn = 0; patchColumn < patchSide; patchColumn++) {
      const pixelIndex = (centerY - patchRadius + patchRow) * width + centerX - patchRadius + patchColumn;
      const horizontalGradient = (values[pixelIndex + 1]! - values[pixelIndex - 1]!) / 2;
      const verticalGradient = (values[pixelIndex + width]! - values[pixelIndex - width]!) / 2;
      gradientX[patchRow * patchSide + patchColumn] = horizontalGradient;
      gradientY[patchRow * patchSide + patchColumn] = verticalGradient;
      sumXX += horizontalGradient * horizontalGradient;
      sumXY += horizontalGradient * verticalGradient;
      sumYY += verticalGradient * verticalGradient;
    }
  }
  const determinant = sumXX * sumYY - sumXY * sumXY;
  if (determinant <= 1e-9) return null;
  return { gradientX, gradientY, inverseHessian: [sumYY / determinant, -sumXY / determinant, sumXX / determinant] };
}

/** Menor autovalor del tensor de estructura (gradientes al cuadrado) por píxel del parche. */
function patchTrackability(reference: GrayImage, centerX: number, centerY: number, patchRadius: number): number {
  const { width, values } = reference;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  for (let rowIndex = centerY - patchRadius; rowIndex <= centerY + patchRadius; rowIndex++) {
    for (let columnIndex = centerX - patchRadius; columnIndex <= centerX + patchRadius; columnIndex++) {
      const pixelIndex = rowIndex * width + columnIndex;
      const horizontalGradient = (values[pixelIndex + 1]! - values[pixelIndex - 1]!) / 2;
      const verticalGradient = (values[pixelIndex + width]! - values[pixelIndex - width]!) / 2;
      sumXX += horizontalGradient * horizontalGradient;
      sumXY += horizontalGradient * verticalGradient;
      sumYY += verticalGradient * verticalGradient;
    }
  }
  const halfTrace = (sumXX + sumYY) / 2;
  const smallestEigenvalue = halfTrace - Math.sqrt(Math.max(0, halfTrace * halfTrace - (sumXX * sumYY - sumXY * sumXY)));
  return smallestEigenvalue / (2 * patchRadius + 1) ** 2;
}

/**
 * Rejilla de puntos de alineado cada `spacingPixels`, quedándose con los parches con contraste
 * en las dos direcciones (el cielo negro o un mar liso no sirven para medir desplazamientos).
 */
export function findAlignmentPoints(
  reference: GrayImage,
  spacingPixels: number,
  patchRadius: number,
  searchRadius: number,
  minimumTrackabilityFraction = 0.1,
): AlignmentPoint[] {
  const margin = patchRadius + searchRadius + 2;
  const candidates: AlignmentPoint[] = [];
  for (let positionY = margin; positionY < reference.height - margin; positionY += spacingPixels) {
    for (let positionX = margin; positionX < reference.width - margin; positionX += spacingPixels) {
      candidates.push({ positionX, positionY, trackability: patchTrackability(reference, positionX, positionY, patchRadius) });
    }
  }
  const highestTrackability = candidates.reduce((highest, candidate) => Math.max(highest, candidate.trackability), 0);
  if (highestTrackability <= 0) return [];
  return candidates.filter((candidate) => candidate.trackability >= minimumTrackabilityFraction * highestTrackability);
}

/**
 * Desplazamiento local de cada punto: búsqueda entera por suma de diferencias al cuadrado en
 * ±`searchRadius` y afinado subpíxel con tres pasos de Lucas-Kanade.
 */
export function measureLocalShifts(
  reference: GrayImage,
  target: GrayImage,
  alignmentPoints: readonly AlignmentPoint[],
  patchRadius: number,
  searchRadius: number,
): LocalShift[] {
  const localShifts: LocalShift[] = [];
  const patchSide = 2 * patchRadius + 1;
  const { width } = reference;
  for (const alignmentPoint of alignmentPoints) {
    const { positionX, positionY } = alignmentPoint;
    let bestShiftX = 0;
    let bestShiftY = 0;
    let lowestDifference = Number.POSITIVE_INFINITY;
    for (let shiftY = -searchRadius; shiftY <= searchRadius; shiftY++) {
      for (let shiftX = -searchRadius; shiftX <= searchRadius; shiftX++) {
        let squaredDifferenceSum = 0;
        for (let patchRow = -patchRadius; patchRow <= patchRadius; patchRow++) {
          const referenceRowStart = (positionY + patchRow) * width + positionX;
          const targetRowStart = (positionY + patchRow + shiftY) * width + positionX + shiftX;
          for (let patchColumn = -patchRadius; patchColumn <= patchRadius; patchColumn++) {
            const difference = target.values[targetRowStart + patchColumn]! - reference.values[referenceRowStart + patchColumn]!;
            squaredDifferenceSum += difference * difference;
          }
        }
        if (squaredDifferenceSum < lowestDifference) {
          lowestDifference = squaredDifferenceSum;
          bestShiftX = shiftX;
          bestShiftY = shiftY;
        }
      }
    }

    const gradients = patchGradients(reference, positionX, positionY, patchRadius);
    if (!gradients) continue;
    let refinedShiftX = bestShiftX;
    let refinedShiftY = bestShiftY;
    for (let iterationIndex = 0; iterationIndex < 3; iterationIndex++) {
      let mismatchAlongX = 0;
      let mismatchAlongY = 0;
      for (let patchRow = 0; patchRow < patchSide; patchRow++) {
        for (let patchColumn = 0; patchColumn < patchSide; patchColumn++) {
          const referenceX = positionX - patchRadius + patchColumn;
          const referenceY = positionY - patchRadius + patchRow;
          const difference =
            sampleBilinear(target, referenceX + refinedShiftX, referenceY + refinedShiftY) -
            reference.values[referenceY * width + referenceX]!;
          mismatchAlongX += gradients.gradientX[patchRow * patchSide + patchColumn]! * difference;
          mismatchAlongY += gradients.gradientY[patchRow * patchSide + patchColumn]! * difference;
        }
      }
      const [inverseXX, inverseXY, inverseYY] = gradients.inverseHessian;
      const stepX = -(inverseXX * mismatchAlongX + inverseXY * mismatchAlongY);
      const stepY = -(inverseXY * mismatchAlongX + inverseYY * mismatchAlongY);
      refinedShiftX += stepX;
      refinedShiftY += stepY;
      if (Math.abs(stepX) + Math.abs(stepY) < 0.01) break;
    }
    // Un desplazamiento fuera del radio de búsqueda es un fallo de seguimiento, no una medida.
    if (Math.abs(refinedShiftX) > searchRadius || Math.abs(refinedShiftY) > searchRadius) continue;
    localShifts.push({ positionX, positionY, shiftX: refinedShiftX, shiftY: refinedShiftY });
  }
  return localShifts;
}

/** Campo de desplazamientos muestreado en una rejilla gruesa, interpolado bilinealmente al usarlo. */
export interface DisplacementField {
  gridStepPixels: number;
  gridColumns: number;
  gridRows: number;
  shiftX: Float32Array;
  shiftY: Float32Array;
}

/**
 * Interpola los desplazamientos de los puntos a una rejilla con pesos gaussianos (Shepard). Un
 * peso fijo hacia 0 hace que, lejos de cualquier punto, el campo se quede en el alineado global.
 */
export function interpolateDisplacementField(
  localShifts: readonly LocalShift[],
  size: number,
  spacingPixels: number,
): DisplacementField {
  const gridStepPixels = Math.max(2, Math.round(spacingPixels / 2));
  const gridColumns = Math.ceil((size - 1) / gridStepPixels) + 1;
  const gridRows = gridColumns;
  const shiftX = new Float32Array(gridColumns * gridRows);
  const shiftY = new Float32Array(gridColumns * gridRows);
  const kernelSigma = 0.75 * spacingPixels;
  const inverseTwiceSigmaSquared = 1 / (2 * kernelSigma * kernelSigma);
  const priorWeight = 0.02;
  for (let gridRow = 0; gridRow < gridRows; gridRow++) {
    for (let gridColumn = 0; gridColumn < gridColumns; gridColumn++) {
      const positionX = gridColumn * gridStepPixels;
      const positionY = gridRow * gridStepPixels;
      let weightSum = priorWeight;
      let weightedShiftX = 0;
      let weightedShiftY = 0;
      for (const localShift of localShifts) {
        const squaredDistance = (localShift.positionX - positionX) ** 2 + (localShift.positionY - positionY) ** 2;
        const weight = Math.exp(-squaredDistance * inverseTwiceSigmaSquared);
        weightSum += weight;
        weightedShiftX += weight * localShift.shiftX;
        weightedShiftY += weight * localShift.shiftY;
      }
      shiftX[gridRow * gridColumns + gridColumn] = weightedShiftX / weightSum;
      shiftY[gridRow * gridColumns + gridColumn] = weightedShiftY / weightSum;
    }
  }
  return { gridStepPixels, gridColumns, gridRows, shiftX, shiftY };
}

/**
 * Remuestrea el fotograma en la geometría de la referencia: el píxel (x, y) toma el valor del
 * fotograma en (x + offsetX + campoX(x, y), y + offsetY + campoY(x, y)).
 */
export function warpFrame(frame: GrayImage, globalOffset: FrameOffset, displacementField?: DisplacementField): GrayImage {
  const { width, height } = frame;
  const warpedValues = new Float32Array(width * height);
  // Posición en la rejilla del campo y peso de interpolación de cada columna (iguales en todas las filas).
  const fieldColumnIndices = new Int32Array(width);
  const fieldColumnWeights = new Float32Array(width);
  if (displacementField) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      const gridPositionX = Math.min(displacementField.gridColumns - 1.000001, columnIndex / displacementField.gridStepPixels);
      fieldColumnIndices[columnIndex] = Math.floor(gridPositionX);
      fieldColumnWeights[columnIndex] = gridPositionX - Math.floor(gridPositionX);
    }
  }
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    let fieldRowStart = 0;
    let fieldRowWeight = 0;
    if (displacementField) {
      const gridPositionY = Math.min(displacementField.gridRows - 1.000001, rowIndex / displacementField.gridStepPixels);
      fieldRowStart = Math.floor(gridPositionY) * displacementField.gridColumns;
      fieldRowWeight = gridPositionY - Math.floor(gridPositionY);
    }
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      let localShiftX = 0;
      let localShiftY = 0;
      if (displacementField) {
        const { gridColumns, shiftX, shiftY } = displacementField;
        const topLeftIndex = fieldRowStart + fieldColumnIndices[columnIndex]!;
        const bottomLeftIndex = topLeftIndex + gridColumns;
        const columnWeight = fieldColumnWeights[columnIndex]!;
        const topShiftX = shiftX[topLeftIndex]! + columnWeight * (shiftX[topLeftIndex + 1]! - shiftX[topLeftIndex]!);
        const bottomShiftX = shiftX[bottomLeftIndex]! + columnWeight * (shiftX[bottomLeftIndex + 1]! - shiftX[bottomLeftIndex]!);
        const topShiftY = shiftY[topLeftIndex]! + columnWeight * (shiftY[topLeftIndex + 1]! - shiftY[topLeftIndex]!);
        const bottomShiftY = shiftY[bottomLeftIndex]! + columnWeight * (shiftY[bottomLeftIndex + 1]! - shiftY[bottomLeftIndex]!);
        localShiftX = topShiftX + fieldRowWeight * (bottomShiftX - topShiftX);
        localShiftY = topShiftY + fieldRowWeight * (bottomShiftY - topShiftY);
      }
      warpedValues[rowIndex * width + columnIndex] = sampleBilinear(
        frame,
        columnIndex + globalOffset.offsetX + localShiftX,
        rowIndex + globalOffset.offsetY + localShiftY,
      );
    }
  }
  return { width, height, values: warpedValues };
}

// ---------------------------------------------------------------------------------------------
// 6. Apilado con media recortada, en dos pasadas y memoria fija
// ---------------------------------------------------------------------------------------------

/**
 * Media recortada en dos pasadas: la primera acumula media y varianza (Welford); la segunda,
 * solo las muestras a menos de κ·σ de la media. Memoria: cuatro planos, sea cual sea el número
 * de fotogramas.
 */
export class SigmaClippedAccumulator {
  private readonly runningMean: Float64Array;
  private readonly runningSquaredDeviation: Float64Array;
  private readonly clippedSum: Float64Array;
  private readonly clippedCount: Uint16Array;
  private firstPassCount = 0;
  private rejectedSampleCount = 0;
  private secondPassSampleCount = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly clippingKappa: number,
    /** Desviación mínima (niveles): sin ella, con fotogramas casi iguales se recortaría el ruido. */
    private readonly minimumSigma = 1,
  ) {
    const pixelCount = width * height;
    this.runningMean = new Float64Array(pixelCount);
    this.runningSquaredDeviation = new Float64Array(pixelCount);
    this.clippedSum = new Float64Array(pixelCount);
    this.clippedCount = new Uint16Array(pixelCount);
  }

  addToFirstPass(frame: GrayImage): void {
    this.firstPassCount++;
    const { values } = frame;
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      const value = values[pixelIndex]!;
      const previousMean = this.runningMean[pixelIndex]!;
      const updatedMean = previousMean + (value - previousMean) / this.firstPassCount;
      this.runningMean[pixelIndex] = updatedMean;
      this.runningSquaredDeviation[pixelIndex] = this.runningSquaredDeviation[pixelIndex]! + (value - previousMean) * (value - updatedMean);
    }
  }

  addToSecondPass(frame: GrayImage): void {
    const { values } = frame;
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      const value = values[pixelIndex]!;
      const sigma = Math.max(this.minimumSigma, Math.sqrt(this.runningSquaredDeviation[pixelIndex]! / this.firstPassCount));
      this.secondPassSampleCount++;
      if (Math.abs(value - this.runningMean[pixelIndex]!) <= this.clippingKappa * sigma) {
        this.clippedSum[pixelIndex] = this.clippedSum[pixelIndex]! + value;
        this.clippedCount[pixelIndex] = this.clippedCount[pixelIndex]! + 1;
      } else {
        this.rejectedSampleCount++;
      }
    }
  }

  /** Media de la primera pasada (sin recortar). */
  meanImage(): GrayImage {
    return { width: this.width, height: this.height, values: Float32Array.from(this.runningMean) };
  }

  /** Media recortada; donde se recortó todo, la media simple. */
  clippedMeanImage(): GrayImage {
    const values = new Float32Array(this.width * this.height);
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      const sampleCount = this.clippedCount[pixelIndex]!;
      values[pixelIndex] = sampleCount > 0 ? this.clippedSum[pixelIndex]! / sampleCount : this.runningMean[pixelIndex]!;
    }
    return { width: this.width, height: this.height, values };
  }

  rejectedFraction(): number {
    return this.secondPassSampleCount > 0 ? this.rejectedSampleCount / this.secondPassSampleCount : 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Proceso completo
// ---------------------------------------------------------------------------------------------

export interface LuckyImagingOptions {
  /** Fracción más nítida que se apila (0,1-0,5 es lo habitual). */
  keptFraction: number;
  /** Mayor desplazamiento global que se busca, en píxeles. */
  maximumGlobalShiftPixels: number;
  /** Separación de los puntos de alineado; 0 = solo alineado global. */
  alignmentPointSpacingPixels: number;
  alignmentPatchRadiusPixels: number;
  /** Mayor desplazamiento local (tras el global) que se busca, en píxeles. */
  localSearchRadiusPixels: number;
  /** κ del recorte; 0 = media simple. */
  sigmaClippingKappa: number;
  /** Zona donde se mide la nitidez (el disco); por defecto, toda la imagen. */
  regionOfInterest?: RegionOfInterest;
}

export const defaultLuckyImagingOptions: LuckyImagingOptions = {
  keptFraction: 0.25,
  maximumGlobalShiftPixels: 24,
  alignmentPointSpacingPixels: 16,
  alignmentPatchRadiusPixels: 7,
  localSearchRadiusPixels: 3,
  sigmaClippingKappa: 2.5,
};

export interface LuckyImagingResult {
  image: GrayImage;
  sharpnessScores: number[];
  /** Fotogramas apilados, de más a menos nítido (el primero es la referencia global). */
  usedFrameIndices: number[];
  globalOffsets: FrameOffset[];
  alignmentPointCount: number;
  /** Fracción de muestras descartadas por el recorte. */
  rejectedSampleFraction: number;
}

function scaleToMean(image: GrayImage, targetMean: number): GrayImage {
  const currentMean = meanOfValues(image.values);
  if (currentMean <= 0) return image;
  const scaleFactor = targetMean / currentMean;
  return { ...image, values: image.values.map((value) => value * scaleFactor) };
}

/** Proceso completo de imagen afortunada sobre una fuente de fotogramas de lado `size`. */
export function stackLuckyFrames(
  frameSource: FrameSource,
  partialOptions: Partial<LuckyImagingOptions> = {},
): LuckyImagingResult {
  const options = { ...defaultLuckyImagingOptions, ...partialOptions };
  if (frameSource.frameCount === 0) throw new Error('No hay fotogramas para apilar');

  // Pasada 1: nitidez de todos.
  const sharpnessScores: number[] = [];
  for (let frameIndex = 0; frameIndex < frameSource.frameCount; frameIndex++) {
    sharpnessScores.push(measureLaplacianSharpness(frameSource.loadFrame(frameIndex), options.regionOfInterest));
  }
  const usedFrameIndices = selectSharpestFrameIndices(sharpnessScores, options.keptFraction);
  const referenceFrame = frameSource.loadFrame(usedFrameIndices[0]!);
  const { width: size, height } = referenceFrame;
  if (size !== height) throw new Error('La imagen afortunada necesita fotogramas cuadrados');
  const referenceMean = meanOfValues(referenceFrame.values);

  // Pasada 2: alineado global con el más nítido y media de los alineados (la referencia local).
  // Se alinea con copias recortadas a los percentiles 2-98 de la referencia: un artefacto muy
  // brillante (un avión) dominaría la diferencia cuadrática y arrastraría el alineado.
  const alignmentFloor = percentileOfValues(referenceFrame.values, 2);
  const alignmentCeiling = percentileOfValues(referenceFrame.values, 98);
  const clampForAlignment = (values: Float32Array) =>
    values.map((value) => (value < alignmentFloor ? alignmentFloor : value > alignmentCeiling ? alignmentCeiling : value));
  const alignToReference = createFrameAligner(clampForAlignment(referenceFrame.values), size, options.maximumGlobalShiftPixels);
  const globalOffsets: FrameOffset[] = [];
  const referenceSum = new Float64Array(size * size);
  for (const [usedIndex, frameIndex] of usedFrameIndices.entries()) {
    const frame = scaleToMean(frameSource.loadFrame(frameIndex), referenceMean);
    const globalOffset = usedIndex === 0 ? { offsetX: 0, offsetY: 0 } : alignToReference(clampForAlignment(frame.values));
    globalOffsets.push(globalOffset);
    const warpedFrame = warpFrame(frame, globalOffset);
    for (let pixelIndex = 0; pixelIndex < referenceSum.length; pixelIndex++) {
      referenceSum[pixelIndex] = referenceSum[pixelIndex]! + warpedFrame.values[pixelIndex]!;
    }
  }
  const localReference: GrayImage = {
    width: size,
    height: size,
    values: Float32Array.from(referenceSum, (valueSum) => valueSum / usedFrameIndices.length),
  };

  // Pasada 3: alineado por puntos y primera pasada del recorte.
  const usesLocalAlignment = options.alignmentPointSpacingPixels > 0;
  const alignmentPoints = usesLocalAlignment
    ? findAlignmentPoints(localReference, options.alignmentPointSpacingPixels, options.alignmentPatchRadiusPixels, options.localSearchRadiusPixels)
    : [];
  const displacementFields: (DisplacementField | undefined)[] = [];
  const accumulator = new SigmaClippedAccumulator(size, size, options.sigmaClippingKappa);
  const loadAlignedFrame = (usedIndex: number) => {
    const frame = scaleToMean(frameSource.loadFrame(usedFrameIndices[usedIndex]!), referenceMean);
    return warpFrame(frame, globalOffsets[usedIndex]!, displacementFields[usedIndex]);
  };
  for (let usedIndex = 0; usedIndex < usedFrameIndices.length; usedIndex++) {
    if (alignmentPoints.length > 0) {
      const globallyAlignedFrame = loadAlignedFrame(usedIndex);
      const localShifts = measureLocalShifts(
        localReference,
        globallyAlignedFrame,
        alignmentPoints,
        options.alignmentPatchRadiusPixels,
        options.localSearchRadiusPixels,
      );
      displacementFields[usedIndex] = interpolateDisplacementField(localShifts, size, options.alignmentPointSpacingPixels);
    }
    accumulator.addToFirstPass(loadAlignedFrame(usedIndex));
  }

  // Pasada 4: media recortada (con los campos ya medidos).
  let stackedImage = accumulator.meanImage();
  if (options.sigmaClippingKappa > 0 && usedFrameIndices.length >= 3) {
    for (let usedIndex = 0; usedIndex < usedFrameIndices.length; usedIndex++) {
      accumulator.addToSecondPass(loadAlignedFrame(usedIndex));
    }
    stackedImage = accumulator.clippedMeanImage();
  }

  return {
    image: stackedImage,
    sharpnessScores,
    usedFrameIndices,
    globalOffsets,
    alignmentPointCount: alignmentPoints.length,
    rejectedSampleFraction: accumulator.rejectedFraction(),
  };
}

// ---------------------------------------------------------------------------------------------
// 7. Realce por ondículas «à trous»
// ---------------------------------------------------------------------------------------------

/** Núcleo B3-spline 1-4-6-4-1 de la transformada «à trous» (Starck y Murtagh). */
const b3SplineKernel = Float32Array.from([1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16]);

export interface WaveletEnhancementOptions {
  /**
   * Ganancia de cada nivel de detalle, del más fino (1-2 px) al más grueso: 1 = sin cambio.
   * Algo como [1,8, 1,5, 1,2, 1] realza el detalle fino de la Luna sin halos gruesos.
   */
  levelGains: readonly number[];
  /**
   * Umbral de ruido en desviaciones (estimadas por nivel con la mediana): el detalle más débil
   * se atenúa (umbral suave) antes de amplificarlo. 0 = sin reducción de ruido.
   */
  noiseThresholdSigmas?: number;
}

/** Descompone en niveles de detalle «à trous» y recompone con ganancias. */
export function enhanceWithWavelets(image: GrayImage, { levelGains, noiseThresholdSigmas = 0 }: WaveletEnhancementOptions): GrayImage {
  const outputValues = new Float32Array(image.values.length);
  let currentApproximation = image;
  for (const [levelIndex, levelGain] of levelGains.entries()) {
    const nextApproximation = convolveSeparable(currentApproximation, b3SplineKernel, 2 ** levelIndex);
    const detailValues = new Float32Array(image.values.length);
    for (let pixelIndex = 0; pixelIndex < detailValues.length; pixelIndex++) {
      detailValues[pixelIndex] = currentApproximation.values[pixelIndex]! - nextApproximation.values[pixelIndex]!;
    }
    let threshold = 0;
    if (noiseThresholdSigmas > 0) {
      const absoluteDetail = detailValues.map(Math.abs);
      threshold = (noiseThresholdSigmas * percentileOfValues(absoluteDetail, 50)) / 0.6745;
    }
    for (let pixelIndex = 0; pixelIndex < detailValues.length; pixelIndex++) {
      const detail = detailValues[pixelIndex]!;
      const shrunkDetail = threshold > 0 ? Math.sign(detail) * Math.max(0, Math.abs(detail) - threshold) : detail;
      outputValues[pixelIndex] = outputValues[pixelIndex]! + levelGain * shrunkDetail;
    }
    currentApproximation = nextApproximation;
  }
  for (let pixelIndex = 0; pixelIndex < outputValues.length; pixelIndex++) {
    outputValues[pixelIndex] = outputValues[pixelIndex]! + currentApproximation.values[pixelIndex]!;
  }
  return { width: image.width, height: image.height, values: outputValues };
}
