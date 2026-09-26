/**
 * Alineado por zonas para el superzoom: tras el alineado global (una traslación por fotograma,
 * `burstSuperResolution`), un campo de desplazamientos suave por fotograma que corrige lo que una
 * traslación no puede:
 *  - pequeños giros de la mano (0,3–0,5° desplazan las esquinas de un recorte de 768 px 2–3 px);
 *  - la cizalla y el estiramiento del obturador electrónico («rolling shutter»): las filas se
 *    leen una tras otra, y si el móvil se mueve durante la lectura cada fila sale corrida un poco
 *    más que la anterior;
 *  - el paralaje entre planos cercanos y lejanos cuando la mano se desplaza (no solo gira).
 *
 * Por cada fotograma:
 *  1. Puntos de alineado en zonas con textura en las dos direcciones (`findAlignmentPoints`).
 *  2. Desplazamiento local de cada punto respecto a la referencia (`measurePatchShifts`), en dos
 *     pasadas: una con búsqueda amplia sobre un subconjunto de puntos para ajustar un modelo
 *     afín, y otra, ya deformado el fotograma con ese modelo, con búsqueda corta en todos.
 *  3. Modelo = afín robusto (giro, escala, cizalla y estiramiento: lo que producen el giro y el
 *     obturador con movimiento uniforme) + residuo local interpolado entre puntos (paralaje y
 *     obturador con movimiento no uniforme). El afín extrapola bien hasta los bordes, donde no hay
 *     puntos; el residuo tiende a 0 lejos de ellos.
 *  4. Fusión en la rejilla fina leyendo cada fotograma en su posición deformada. No se remuestrean
 *     los fotogramas antes de fusionar (eso los emborronaría y perdería justo el detalle subpíxel
 *     que aporta la ráfaga): la deformación entra en la posición de cada muestra.
 *
 * Módulo puro: sin React ni React Native. Bucles escritos para Hermes (sin JIT).
 */

import {
  computeLuminance,
  computeRobustnessMap,
  createFrameAligner,
  type FrameOffset,
  kernelSigmaForFrameCount,
  type MergeOptions,
  type SuperResolutionOptions,
  type SuperResolutionResult,
  upscaleFrameBilinear,
} from './burstSuperResolution';
import type { GrayImage } from './grayImage';
import {
  type AlignmentPoint,
  type DisplacementField,
  findAlignmentPoints,
  interpolateDisplacementField,
  type LocalShift,
} from './luckyImaging';
import { type FloatRgbImage, measureCropSharpness } from './lunarStacking';

// ---------------------------------------------------------------------------------------------
// Modelo afín robusto
// ---------------------------------------------------------------------------------------------

/**
 * Desplazamiento afín alrededor de (centerX, centerY):
 *   dx = offsetX + xFromX·(x − cx) + xFromY·(y − cy)
 *   dy = offsetY + yFromX·(x − cx) + yFromY·(y − cy)
 * Un giro θ pequeño da xFromY = −θ, yFromX = θ; la cizalla del obturador, xFromY ≠ 0 sola.
 */
export interface AffineDisplacement {
  centerX: number;
  centerY: number;
  offsetX: number;
  offsetY: number;
  xFromX: number;
  xFromY: number;
  yFromX: number;
  yFromY: number;
}

export function identityAffineDisplacement(centerX: number, centerY: number): AffineDisplacement {
  return { centerX, centerY, offsetX: 0, offsetY: 0, xFromX: 0, xFromY: 0, yFromX: 0, yFromY: 0 };
}

export function evaluateAffineDisplacement(affine: AffineDisplacement, positionX: number, positionY: number): { x: number; y: number } {
  const relativeX = positionX - affine.centerX;
  const relativeY = positionY - affine.centerY;
  return {
    x: affine.offsetX + affine.xFromX * relativeX + affine.xFromY * relativeY,
    y: affine.offsetY + affine.yFromX * relativeX + affine.yFromY * relativeY,
  };
}

/** Resuelve un sistema 3×3 simétrico por Cramer; `null` si es singular. */
function solveSymmetricThreeByThree(matrix: readonly number[], rightHandSide: readonly number[]): number[] | null {
  const [m00, m01, m02, , m11, m12, , , m22] = matrix as [number, number, number, number, number, number, number, number, number];
  const determinant = m00 * (m11 * m22 - m12 * m12) - m01 * (m01 * m22 - m12 * m02) + m02 * (m01 * m12 - m11 * m02);
  if (Math.abs(determinant) < 1e-12) return null;
  const [r0, r1, r2] = rightHandSide as [number, number, number];
  const solution0 = (r0 * (m11 * m22 - m12 * m12) - m01 * (r1 * m22 - m12 * r2) + m02 * (r1 * m12 - m11 * r2)) / determinant;
  const solution1 = (m00 * (r1 * m22 - m12 * r2) - r0 * (m01 * m22 - m12 * m02) + m02 * (m01 * r2 - r1 * m02)) / determinant;
  const solution2 = (m00 * (m11 * r2 - r1 * m12) - m01 * (m01 * r2 - r1 * m02) + r0 * (m01 * m12 - m11 * m02)) / determinant;
  return [solution0, solution1, solution2];
}

function leastSquaresAffine(localShifts: readonly LocalShift[], centerX: number, centerY: number): AffineDisplacement | null {
  // Ecuaciones normales de [1, x, y] (las mismas para dx y para dy).
  let sumOne = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  let sumShiftX = 0;
  let sumShiftXTimesX = 0;
  let sumShiftXTimesY = 0;
  let sumShiftY = 0;
  let sumShiftYTimesX = 0;
  let sumShiftYTimesY = 0;
  for (const localShift of localShifts) {
    const relativeX = localShift.positionX - centerX;
    const relativeY = localShift.positionY - centerY;
    sumOne += 1;
    sumX += relativeX;
    sumY += relativeY;
    sumXX += relativeX * relativeX;
    sumXY += relativeX * relativeY;
    sumYY += relativeY * relativeY;
    sumShiftX += localShift.shiftX;
    sumShiftXTimesX += localShift.shiftX * relativeX;
    sumShiftXTimesY += localShift.shiftX * relativeY;
    sumShiftY += localShift.shiftY;
    sumShiftYTimesX += localShift.shiftY * relativeX;
    sumShiftYTimesY += localShift.shiftY * relativeY;
  }
  const normalMatrix = [sumOne, sumX, sumY, sumX, sumXX, sumXY, sumY, sumXY, sumYY];
  const horizontalSolution = solveSymmetricThreeByThree(normalMatrix, [sumShiftX, sumShiftXTimesX, sumShiftXTimesY]);
  const verticalSolution = solveSymmetricThreeByThree(normalMatrix, [sumShiftY, sumShiftYTimesX, sumShiftYTimesY]);
  if (!horizontalSolution || !verticalSolution) return null;
  return {
    centerX,
    centerY,
    offsetX: horizontalSolution[0]!,
    xFromX: horizontalSolution[1]!,
    xFromY: horizontalSolution[2]!,
    offsetY: verticalSolution[0]!,
    yFromX: verticalSolution[1]!,
    yFromY: verticalSolution[2]!,
  };
}

/** Por debajo de estos puntos el afín (6 parámetros) no es fiable: se queda en la identidad. */
const minimumPointsForAffine = 8;
/** Residuo mínimo tolerado (px): por debajo, las diferencias son ruido de medida. */
const minimumInlierResidualPixels = 0.35;

export interface RobustAffineFit {
  affine: AffineDisplacement;
  /** Puntos que casan con el modelo (se descartan los de cosas que se han movido o mal medidos). */
  inlierShifts: LocalShift[];
}

/**
 * Afín por mínimos cuadrados con rechazo iterativo de puntos: se quitan los que se alejan más
 * de 3 desviaciones (estimadas con la mediana) o del mínimo de 0,35 px, y se reajusta.
 */
export function fitRobustAffineDisplacement(
  localShifts: readonly LocalShift[],
  centerX: number,
  centerY: number,
): RobustAffineFit {
  let inlierShifts = [...localShifts];
  let affine = identityAffineDisplacement(centerX, centerY);
  if (inlierShifts.length < minimumPointsForAffine) return { affine, inlierShifts };
  for (let iterationIndex = 0; iterationIndex < 4; iterationIndex++) {
    const fittedAffine = leastSquaresAffine(inlierShifts, centerX, centerY);
    if (!fittedAffine) break;
    affine = fittedAffine;
    const residualMagnitudes = localShifts.map((localShift) => {
      const modelShift = evaluateAffineDisplacement(affine, localShift.positionX, localShift.positionY);
      return Math.hypot(localShift.shiftX - modelShift.x, localShift.shiftY - modelShift.y);
    });
    const sortedResiduals = [...residualMagnitudes].sort((first, second) => first - second);
    const medianResidual = sortedResiduals[Math.floor(sortedResiduals.length / 2)] ?? 0;
    const residualThreshold = Math.max(minimumInlierResidualPixels, 3 * 1.4826 * medianResidual);
    const nextInliers = localShifts.filter((_localShift, shiftIndex) => residualMagnitudes[shiftIndex]! <= residualThreshold);
    if (nextInliers.length < minimumPointsForAffine) break;
    const hasConverged = nextInliers.length === inlierShifts.length;
    inlierShifts = nextInliers;
    if (hasConverged) break;
  }
  return { affine, inlierShifts };
}

// ---------------------------------------------------------------------------------------------
// Campo de desplazamientos
// ---------------------------------------------------------------------------------------------

/** Peso fijo hacia 0 del residuo (el mismo que `interpolateDisplacementField`): lejos de los puntos manda el afín. */
const residualPriorWeight = 0.02;

/**
 * Interpola los residuos de los puntos a la rejilla de `interpolateDisplacementField` (paso =
 * media separación, pesos gaussianos de σ = 0,75 separaciones y el mismo peso fijo hacia 0),
 * pero repartiendo cada punto solo sobre los nodos a menos de 3σ: con ~500 puntos, la versión
 * que suma todos los puntos en cada nodo hace ~100 veces más exponenciales.
 */
export function interpolateResidualField(localShifts: readonly LocalShift[], size: number, spacingPixels: number): DisplacementField {
  const field = interpolateDisplacementField([], size, spacingPixels);
  const { gridColumns, gridRows, gridStepPixels } = field;
  const weightSums = new Float32Array(gridColumns * gridRows).fill(residualPriorWeight);
  const kernelSigma = 0.75 * spacingPixels;
  const inverseTwiceSigmaSquared = 1 / (2 * kernelSigma * kernelSigma);
  const reachInNodes = Math.ceil((3 * kernelSigma) / gridStepPixels);
  for (const localShift of localShifts) {
    const nearestColumn = Math.round(localShift.positionX / gridStepPixels);
    const nearestRow = Math.round(localShift.positionY / gridStepPixels);
    for (let gridRow = Math.max(0, nearestRow - reachInNodes); gridRow <= Math.min(gridRows - 1, nearestRow + reachInNodes); gridRow++) {
      const verticalDistance = gridRow * gridStepPixels - localShift.positionY;
      for (
        let gridColumn = Math.max(0, nearestColumn - reachInNodes);
        gridColumn <= Math.min(gridColumns - 1, nearestColumn + reachInNodes);
        gridColumn++
      ) {
        const horizontalDistance = gridColumn * gridStepPixels - localShift.positionX;
        const weight = Math.exp(-(horizontalDistance * horizontalDistance + verticalDistance * verticalDistance) * inverseTwiceSigmaSquared);
        const nodeIndex = gridRow * gridColumns + gridColumn;
        weightSums[nodeIndex] = weightSums[nodeIndex]! + weight;
        field.shiftX[nodeIndex] = field.shiftX[nodeIndex]! + weight * localShift.shiftX;
        field.shiftY[nodeIndex] = field.shiftY[nodeIndex]! + weight * localShift.shiftY;
      }
    }
  }
  for (let nodeIndex = 0; nodeIndex < weightSums.length; nodeIndex++) {
    field.shiftX[nodeIndex] = field.shiftX[nodeIndex]! / weightSums[nodeIndex]!;
    field.shiftY[nodeIndex] = field.shiftY[nodeIndex]! / weightSums[nodeIndex]!;
  }
  return field;
}

/** Campo en la rejilla de `interpolateDisplacementField` con el afín evaluado en cada nodo. */
function affineDisplacementField(affine: AffineDisplacement, size: number, spacingPixels: number): DisplacementField {
  const emptyField = interpolateDisplacementField([], size, spacingPixels);
  addAffineToField(emptyField, affine);
  return emptyField;
}

function addAffineToField(field: DisplacementField, affine: AffineDisplacement): void {
  for (let gridRow = 0; gridRow < field.gridRows; gridRow++) {
    for (let gridColumn = 0; gridColumn < field.gridColumns; gridColumn++) {
      const nodeIndex = gridRow * field.gridColumns + gridColumn;
      const modelShift = evaluateAffineDisplacement(affine, gridColumn * field.gridStepPixels, gridRow * field.gridStepPixels);
      field.shiftX[nodeIndex] = field.shiftX[nodeIndex]! + modelShift.x;
      field.shiftY[nodeIndex] = field.shiftY[nodeIndex]! + modelShift.y;
    }
  }
}

/**
 * Desplazamiento total (global + campo) en cada píxel de la referencia: el píxel (x, y) de la
 * referencia está en (x + desplazamientoX, y + desplazamientoY) del fotograma.
 */
export interface DenseDisplacement {
  size: number;
  shiftX: Float32Array;
  shiftY: Float32Array;
}

export function denseDisplacement(size: number, globalOffset: FrameOffset, field?: DisplacementField | null): DenseDisplacement {
  const shiftX = new Float32Array(size * size).fill(globalOffset.offsetX);
  const shiftY = new Float32Array(size * size).fill(globalOffset.offsetY);
  if (!field) return { size, shiftX, shiftY };
  const { gridColumns, gridRows, gridStepPixels } = field;
  const fieldColumnIndices = new Int32Array(size);
  const fieldColumnWeights = new Float32Array(size);
  for (let columnIndex = 0; columnIndex < size; columnIndex++) {
    const gridPositionX = Math.min(gridColumns - 1.000001, columnIndex / gridStepPixels);
    fieldColumnIndices[columnIndex] = Math.floor(gridPositionX);
    fieldColumnWeights[columnIndex] = gridPositionX - Math.floor(gridPositionX);
  }
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    const gridPositionY = Math.min(gridRows - 1.000001, rowIndex / gridStepPixels);
    const fieldRowStart = Math.floor(gridPositionY) * gridColumns;
    const rowWeight = gridPositionY - Math.floor(gridPositionY);
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      const topLeftIndex = fieldRowStart + fieldColumnIndices[columnIndex]!;
      const bottomLeftIndex = topLeftIndex + gridColumns;
      const columnWeight = fieldColumnWeights[columnIndex]!;
      const topShiftX = field.shiftX[topLeftIndex]! + columnWeight * (field.shiftX[topLeftIndex + 1]! - field.shiftX[topLeftIndex]!);
      const bottomShiftX =
        field.shiftX[bottomLeftIndex]! + columnWeight * (field.shiftX[bottomLeftIndex + 1]! - field.shiftX[bottomLeftIndex]!);
      const topShiftY = field.shiftY[topLeftIndex]! + columnWeight * (field.shiftY[topLeftIndex + 1]! - field.shiftY[topLeftIndex]!);
      const bottomShiftY =
        field.shiftY[bottomLeftIndex]! + columnWeight * (field.shiftY[bottomLeftIndex + 1]! - field.shiftY[bottomLeftIndex]!);
      const pixelIndex = rowIndex * size + columnIndex;
      shiftX[pixelIndex] = shiftX[pixelIndex]! + topShiftX + rowWeight * (bottomShiftX - topShiftX);
      shiftY[pixelIndex] = shiftY[pixelIndex]! + topShiftY + rowWeight * (bottomShiftY - topShiftY);
    }
  }
  return { size, shiftX, shiftY };
}

/**
 * Remuestrea (bilineal) el fotograma en la geometría de la referencia: el píxel (x, y) toma el
 * valor del fotograma en (x, y) + desplazamiento; fuera de la imagen se repite el borde. Hace lo
 * mismo que `warpFrame` de `luckyImaging`, pero sin llamadas a funciones por píxel (en Hermes,
 * sin JIT, son lo que más cuesta).
 */
export function warpWithDisplacement(frame: GrayImage, displacement: DenseDisplacement): GrayImage {
  const { width: size, values } = frame;
  const warpedValues = new Float32Array(size * size);
  const lastIndex = size - 1;
  const lastTopLeft = size - 2;
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      const pixelIndex = rowIndex * size + columnIndex;
      let sourceX = columnIndex + displacement.shiftX[pixelIndex]!;
      let sourceY = rowIndex + displacement.shiftY[pixelIndex]!;
      if (sourceX < 0) sourceX = 0;
      else if (sourceX > lastIndex) sourceX = lastIndex;
      if (sourceY < 0) sourceY = 0;
      else if (sourceY > lastIndex) sourceY = lastIndex;
      let leftColumn = sourceX | 0;
      if (leftColumn > lastTopLeft) leftColumn = lastTopLeft;
      let topRow = sourceY | 0;
      if (topRow > lastTopLeft) topRow = lastTopLeft;
      const horizontalWeight = sourceX - leftColumn;
      const verticalWeight = sourceY - topRow;
      const topLeftIndex = topRow * size + leftColumn;
      const topValue = values[topLeftIndex]! + horizontalWeight * (values[topLeftIndex + 1]! - values[topLeftIndex]!);
      const bottomValue =
        values[topLeftIndex + size]! + horizontalWeight * (values[topLeftIndex + size + 1]! - values[topLeftIndex + size]!);
      warpedValues[pixelIndex] = topValue + verticalWeight * (bottomValue - topValue);
    }
  }
  return { width: size, height: size, values: warpedValues };
}

/**
 * Desplazamiento local de cada punto (como `measureLocalShifts` de `luckyImaging`, optimizado):
 * búsqueda entera por suma de diferencias al cuadrado en ±`searchRadius` mirando uno de cada dos
 * píxeles del parche (sobra para el valor entero) y afinado subpíxel con Lucas-Kanade sobre el
 * parche completo. Como el desplazamiento es el mismo en todo el parche, los pesos bilineales se
 * calculan una vez por iteración. Los puntos deben estar al menos a
 * `patchRadius + searchRadius + 2` del borde (lo garantiza `findAlignmentPoints`).
 */
export function measurePatchShifts(
  reference: GrayImage,
  target: GrayImage,
  alignmentPoints: readonly AlignmentPoint[],
  patchRadius: number,
  searchRadius: number,
): LocalShift[] {
  const { width } = reference;
  const referenceValues = reference.values;
  const targetValues = target.values;
  const patchSide = 2 * patchRadius + 1;
  const patchGradientX = new Float32Array(patchSide * patchSide);
  const patchGradientY = new Float32Array(patchSide * patchSide);
  // Para redondear hacia abajo con `| 0`, los desplazamientos se hacen positivos antes.
  const floorBias = searchRadius + 4;
  const localShifts: LocalShift[] = [];
  for (const alignmentPoint of alignmentPoints) {
    const { positionX, positionY } = alignmentPoint;
    const patchStartIndex = (positionY - patchRadius) * width + positionX - patchRadius;

    let bestShiftX = 0;
    let bestShiftY = 0;
    let lowestDifference = Number.POSITIVE_INFINITY;
    for (let shiftY = -searchRadius; shiftY <= searchRadius; shiftY++) {
      for (let shiftX = -searchRadius; shiftX <= searchRadius; shiftX++) {
        const shiftIndex = shiftY * width + shiftX;
        let squaredDifferenceSum = 0;
        for (let patchRow = 0; patchRow < patchSide && squaredDifferenceSum < lowestDifference; patchRow += 2) {
          const referenceRowStart = patchStartIndex + patchRow * width;
          for (let patchColumn = 0; patchColumn < patchSide; patchColumn += 2) {
            const difference = targetValues[referenceRowStart + patchColumn + shiftIndex]! - referenceValues[referenceRowStart + patchColumn]!;
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

    // Gradientes de la referencia en el parche y su matriz 2×2 (la de Lucas-Kanade).
    let sumXX = 0;
    let sumXY = 0;
    let sumYY = 0;
    for (let patchRow = 0; patchRow < patchSide; patchRow++) {
      for (let patchColumn = 0; patchColumn < patchSide; patchColumn++) {
        const pixelIndex = patchStartIndex + patchRow * width + patchColumn;
        const horizontalGradient = (referenceValues[pixelIndex + 1]! - referenceValues[pixelIndex - 1]!) / 2;
        const verticalGradient = (referenceValues[pixelIndex + width]! - referenceValues[pixelIndex - width]!) / 2;
        patchGradientX[patchRow * patchSide + patchColumn] = horizontalGradient;
        patchGradientY[patchRow * patchSide + patchColumn] = verticalGradient;
        sumXX += horizontalGradient * horizontalGradient;
        sumXY += horizontalGradient * verticalGradient;
        sumYY += verticalGradient * verticalGradient;
      }
    }
    const determinant = sumXX * sumYY - sumXY * sumXY;
    if (determinant <= 1e-9) continue;

    let refinedShiftX = bestShiftX;
    let refinedShiftY = bestShiftY;
    let isTrackingLost = false;
    for (let iterationIndex = 0; iterationIndex < 4; iterationIndex++) {
      const integerShiftX = ((refinedShiftX + floorBias) | 0) - floorBias;
      const integerShiftY = ((refinedShiftY + floorBias) | 0) - floorBias;
      const horizontalWeight = refinedShiftX - integerShiftX;
      const verticalWeight = refinedShiftY - integerShiftY;
      const shiftIndex = integerShiftY * width + integerShiftX;
      let mismatchAlongX = 0;
      let mismatchAlongY = 0;
      for (let patchRow = 0; patchRow < patchSide; patchRow++) {
        const referenceRowStart = patchStartIndex + patchRow * width;
        for (let patchColumn = 0; patchColumn < patchSide; patchColumn++) {
          const referenceIndex = referenceRowStart + patchColumn;
          const topLeftIndex = referenceIndex + shiftIndex;
          const topValue = targetValues[topLeftIndex]! + horizontalWeight * (targetValues[topLeftIndex + 1]! - targetValues[topLeftIndex]!);
          const bottomValue =
            targetValues[topLeftIndex + width]! +
            horizontalWeight * (targetValues[topLeftIndex + width + 1]! - targetValues[topLeftIndex + width]!);
          const difference = topValue + verticalWeight * (bottomValue - topValue) - referenceValues[referenceIndex]!;
          mismatchAlongX += patchGradientX[patchRow * patchSide + patchColumn]! * difference;
          mismatchAlongY += patchGradientY[patchRow * patchSide + patchColumn]! * difference;
        }
      }
      const stepX = -(sumYY * mismatchAlongX - sumXY * mismatchAlongY) / determinant;
      const stepY = -(-sumXY * mismatchAlongX + sumXX * mismatchAlongY) / determinant;
      refinedShiftX += stepX;
      refinedShiftY += stepY;
      // Fuera del radio de búsqueda es un fallo de seguimiento, no una medida (y leería fuera).
      if (refinedShiftX > searchRadius || refinedShiftX < -searchRadius || refinedShiftY > searchRadius || refinedShiftY < -searchRadius) {
        isTrackingLost = true;
        break;
      }
      if ((stepX < 0 ? -stepX : stepX) + (stepY < 0 ? -stepY : stepY) < 0.005) break;
    }
    if (isTrackingLost) continue;
    localShifts.push({ positionX, positionY, shiftX: refinedShiftX, shiftY: refinedShiftY });
  }
  return localShifts;
}

// ---------------------------------------------------------------------------------------------
// Medida del campo de un fotograma
// ---------------------------------------------------------------------------------------------

export interface LocalAlignmentOptions {
  /** Separación de los puntos de alineado (px); por defecto, según el tamaño del recorte. */
  pointSpacingPixels: number;
  patchRadiusPixels: number;
  /** Búsqueda de la primera pasada (tras el global): cubre giros de ~0,5° en las esquinas. */
  coarseSearchRadiusPixels: number;
  /** Búsqueda de la segunda pasada (tras deformar con el afín). */
  fineSearchRadiusPixels: number;
}

/** Unos 20-24 puntos por lado sea cual sea el recorte: el coste queda acotado. */
export function defaultLocalAlignmentOptions(size: number): LocalAlignmentOptions {
  return {
    pointSpacingPixels: Math.max(16, Math.round(size / 24)),
    patchRadiusPixels: size >= 256 ? 8 : 6,
    coarseSearchRadiusPixels: 5,
    fineSearchRadiusPixels: 2,
  };
}

export interface FrameLocalAlignment {
  /** Campo (sin el global) en la rejilla de `interpolateDisplacementField`. */
  field: DisplacementField;
  affine: AffineDisplacement;
  measuredPointCount: number;
  inlierPointCount: number;
}

/**
 * Campo de desplazamientos de un fotograma ya alineado globalmente con la referencia. Ambas
 * imágenes con el mismo brillo medio. `null` si no hay textura suficiente para medirlo.
 */
export function measureFrameLocalAlignment(
  reference: GrayImage,
  frame: GrayImage,
  globalOffset: FrameOffset,
  alignmentPoints: readonly AlignmentPoint[],
  options: LocalAlignmentOptions,
): FrameLocalAlignment | null {
  const size = reference.width;
  const imageCenter = (size - 1) / 2;
  if (alignmentPoints.length < minimumPointsForAffine) return null;

  // Pasada 1: uno de cada cuatro puntos, búsqueda amplia, solo para el afín.
  const coarsePoints = alignmentPoints.filter((_point, pointIndex) => pointIndex % 4 === 0);
  const globallyAlignedFrame = warpWithDisplacement(frame, denseDisplacement(size, globalOffset));
  const coarseShifts = measurePatchShifts(
    reference,
    globallyAlignedFrame,
    coarsePoints.length >= 3 * minimumPointsForAffine ? coarsePoints : alignmentPoints,
    options.patchRadiusPixels,
    options.coarseSearchRadiusPixels,
  );
  const coarseFit = fitRobustAffineDisplacement(coarseShifts, imageCenter, imageCenter);

  // Pasada 2: todos los puntos, sobre el fotograma deformado con el afín.
  const coarseField = affineDisplacementField(coarseFit.affine, size, options.pointSpacingPixels);
  const affineAlignedFrame = warpWithDisplacement(frame, denseDisplacement(size, globalOffset, coarseField));
  const residualShifts = measurePatchShifts(
    reference,
    affineAlignedFrame,
    alignmentPoints,
    options.patchRadiusPixels,
    options.fineSearchRadiusPixels,
  );
  if (residualShifts.length < minimumPointsForAffine) return null;
  const totalShifts: LocalShift[] = residualShifts.map((residualShift) => {
    const coarseShift = evaluateAffineDisplacement(coarseFit.affine, residualShift.positionX, residualShift.positionY);
    return {
      positionX: residualShift.positionX,
      positionY: residualShift.positionY,
      shiftX: coarseShift.x + residualShift.shiftX,
      shiftY: coarseShift.y + residualShift.shiftY,
    };
  });
  const finalFit = fitRobustAffineDisplacement(totalShifts, imageCenter, imageCenter);
  // Lo que el afín no explica, interpolado entre los puntos buenos (tiende a 0 lejos de ellos).
  const localResiduals = finalFit.inlierShifts.map((localShift) => {
    const modelShift = evaluateAffineDisplacement(finalFit.affine, localShift.positionX, localShift.positionY);
    return {
      positionX: localShift.positionX,
      positionY: localShift.positionY,
      shiftX: localShift.shiftX - modelShift.x,
      shiftY: localShift.shiftY - modelShift.y,
    };
  });
  const field = interpolateResidualField(localResiduals, size, options.pointSpacingPixels);
  addAffineToField(field, finalFit.affine);
  return {
    field,
    affine: finalFit.affine,
    measuredPointCount: totalShifts.length,
    inlierPointCount: finalFit.inlierShifts.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Fusión con desplazamiento por píxel
// ---------------------------------------------------------------------------------------------

/** Por debajo de este peso de parecido, el fotograma no aporta nada en ese punto. */
const negligibleRobustnessWeight = 0.01;
const gaussianWeightTableSteps = 512;

/**
 * Como `mergeFramesToFinerGrid`, pero con el desplazamiento de cada fotograma leído en cada píxel
 * (global + campo local). Cada píxel de salida recoge los 2×2 píxeles más cercanos de cada
 * fotograma, pesados por una gaussiana de la distancia (tabulada) y por el mapa de parecido.
 * `null` en `displacements` = sin desplazamiento (la referencia).
 */
export function mergeFramesWithDisplacements(
  frames: readonly Uint8Array[],
  displacements: readonly (DenseDisplacement | null)[],
  robustnessMaps: readonly (Float32Array | null)[],
  size: number,
  { scale, kernelSigmaPixels }: MergeOptions,
): FloatRgbImage {
  const outputSize = size * scale;
  const channelSums = new Float32Array(outputSize * outputSize * 3);
  const weightSums = new Float32Array(outputSize * outputSize);
  const inverseTwiceSigmaSquared = 1 / (2 * kernelSigmaPixels * kernelSigmaPixels);
  const gaussianWeightTable = new Float32Array(gaussianWeightTableSteps + 2);
  for (let tableIndex = 0; tableIndex < gaussianWeightTable.length; tableIndex++) {
    const distance = tableIndex / gaussianWeightTableSteps;
    gaussianWeightTable[tableIndex] = Math.exp(-distance * distance * inverseTwiceSigmaSquared);
  }
  const nearestReferenceIndices = new Int32Array(outputSize);
  const inputPositions = new Float32Array(outputSize);
  for (let outputCoordinate = 0; outputCoordinate < outputSize; outputCoordinate++) {
    const inputPosition = (outputCoordinate + 0.5) / scale - 0.5;
    inputPositions[outputCoordinate] = inputPosition;
    nearestReferenceIndices[outputCoordinate] = Math.min(size - 1, Math.max(0, Math.round(inputPosition)));
  }
  const rowStride = size * 3;
  const lastIndex = size - 1;

  frames.forEach((framePixels, frameIndex) => {
    const displacement = displacements[frameIndex] ?? null;
    const robustnessMap = robustnessMaps[frameIndex] ?? null;
    for (let outputRow = 0; outputRow < outputSize; outputRow++) {
      const referenceRowStart = nearestReferenceIndices[outputRow]! * size;
      const baseRowPosition = inputPositions[outputRow]!;
      const outputRowStart = outputRow * outputSize;
      for (let outputColumn = 0; outputColumn < outputSize; outputColumn++) {
        const referenceIndex = referenceRowStart + nearestReferenceIndices[outputColumn]!;
        let robustnessWeight = 1;
        if (robustnessMap) {
          robustnessWeight = robustnessMap[referenceIndex]!;
          if (robustnessWeight < negligibleRobustnessWeight) continue;
        }
        let sourceX = inputPositions[outputColumn]!;
        let sourceY = baseRowPosition;
        if (displacement) {
          sourceX += displacement.shiftX[referenceIndex]!;
          sourceY += displacement.shiftY[referenceIndex]!;
        }
        if (sourceX < -1 || sourceX >= size || sourceY < -1 || sourceY >= size) continue;
        // Sin llamadas a Math por píxel (en Hermes cada una cuesta): `| 0` trunca, y con el +1
        // el valor ya es positivo, así que truncar es redondear hacia abajo.
        const leftColumn = ((sourceX + 1) | 0) - 1;
        const topRow = ((sourceY + 1) | 0) - 1;
        const leftDistance = sourceX - leftColumn;
        const topDistance = sourceY - topRow;
        let leftWeight = leftColumn >= 0 ? gaussianWeightTable[(leftDistance * gaussianWeightTableSteps + 0.5) | 0]! : 0;
        let rightWeight = leftColumn < lastIndex ? gaussianWeightTable[((1 - leftDistance) * gaussianWeightTableSteps + 0.5) | 0]! : 0;
        const topWeight = topRow >= 0 ? gaussianWeightTable[(topDistance * gaussianWeightTableSteps + 0.5) | 0]! : 0;
        const bottomWeight = topRow < lastIndex ? gaussianWeightTable[((1 - topDistance) * gaussianWeightTableSteps + 0.5) | 0]! : 0;
        leftWeight *= robustnessWeight;
        rightWeight *= robustnessWeight;
        const leftColumnOffset = (leftColumn < 0 ? 0 : leftColumn) * 3;
        const rightColumnOffset = (leftColumn < lastIndex ? leftColumn + 1 : lastIndex) * 3;
        const topRowStart = (topRow < 0 ? 0 : topRow) * rowStride;
        const bottomRowStart = (topRow < lastIndex ? topRow + 1 : lastIndex) * rowStride;
        const topLeftWeight = topWeight * leftWeight;
        const topRightWeight = topWeight * rightWeight;
        const bottomLeftWeight = bottomWeight * leftWeight;
        const bottomRightWeight = bottomWeight * rightWeight;
        const topLeftOffset = topRowStart + leftColumnOffset;
        const topRightOffset = topRowStart + rightColumnOffset;
        const bottomLeftOffset = bottomRowStart + leftColumnOffset;
        const bottomRightOffset = bottomRowStart + rightColumnOffset;
        const outputPixelIndex = outputRowStart + outputColumn;
        const sumOffset = outputPixelIndex * 3;
        for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
          channelSums[sumOffset + channelIndex] =
            channelSums[sumOffset + channelIndex]! +
            topLeftWeight * framePixels[topLeftOffset + channelIndex]! +
            topRightWeight * framePixels[topRightOffset + channelIndex]! +
            bottomLeftWeight * framePixels[bottomLeftOffset + channelIndex]! +
            bottomRightWeight * framePixels[bottomRightOffset + channelIndex]!;
        }
        weightSums[outputPixelIndex] =
          weightSums[outputPixelIndex]! + topLeftWeight + topRightWeight + bottomLeftWeight + bottomRightWeight;
      }
    }
  });

  for (let outputPixelIndex = 0; outputPixelIndex < weightSums.length; outputPixelIndex++) {
    const weightSum = weightSums[outputPixelIndex]!;
    if (weightSum <= 0) continue;
    const sumOffset = outputPixelIndex * 3;
    channelSums[sumOffset] = channelSums[sumOffset]! / weightSum;
    channelSums[sumOffset + 1] = channelSums[sumOffset + 1]! / weightSum;
    channelSums[sumOffset + 2] = channelSums[sumOffset + 2]! / weightSum;
  }
  return { size: outputSize, channels: channelSums };
}

/**
 * Mapa de parecido de un fotograma ya deformado a la geometría de la referencia. Donde la
 * posición deformada cae fuera del fotograma, peso 0 (no hay dato, solo el borde repetido).
 */
function robustnessMapForWarpedFrame(
  referenceLuminance: Float32Array,
  warpedLuminance: Float32Array,
  displacement: DenseDisplacement,
  size: number,
): Float32Array {
  const robustnessMap = computeRobustnessMap(referenceLuminance, warpedLuminance, size, { offsetX: 0, offsetY: 0 });
  const lastIndex = size - 1;
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      const pixelIndex = rowIndex * size + columnIndex;
      const sourceX = columnIndex + displacement.shiftX[pixelIndex]!;
      const sourceY = rowIndex + displacement.shiftY[pixelIndex]!;
      if (sourceX < 0 || sourceX > lastIndex || sourceY < 0 || sourceY > lastIndex) robustnessMap[pixelIndex] = 0;
    }
  }
  // La última fila y columna quedan sin medir en `computeRobustnessMap` (le falta el vecino).
  for (let coordinate = 0; coordinate < size; coordinate++) {
    robustnessMap[lastIndex * size + coordinate] = robustnessMap[(lastIndex - 1) * size + coordinate]!;
    robustnessMap[coordinate * size + lastIndex] = robustnessMap[coordinate * size + lastIndex - 1]!;
  }
  return robustnessMap;
}

// ---------------------------------------------------------------------------------------------
// Color igual en todas las fotos
// ---------------------------------------------------------------------------------------------

/** Diferencias de ganancia menores que esta no se corrigen (el redondeo a 8 bits costaría más). */
const negligibleGainDeviation = 0.003;

/** Media de cada canal en la zona central (sin un 10 % por lado: lo que entra y sale por el temblor). */
function centralChannelMeans(rgbPixels: Uint8Array, size: number): [number, number, number] {
  const margin = Math.floor(size / 10);
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let pixelCount = 0;
  for (let rowIndex = margin; rowIndex < size - margin; rowIndex++) {
    for (let columnIndex = margin; columnIndex < size - margin; columnIndex++) {
      const pixelOffset = (rowIndex * size + columnIndex) * 3;
      redSum += rgbPixels[pixelOffset]!;
      greenSum += rgbPixels[pixelOffset + 1]!;
      blueSum += rgbPixels[pixelOffset + 2]!;
      pixelCount++;
    }
  }
  return [redSum / pixelCount, greenSum / pixelCount, blueSum / pixelCount];
}

export interface ColorGainEqualization {
  frames: Uint8Array[];
  /** Mayor corrección aplicada a un canal de una foto (0,02 = un 2 %). */
  largestGainDeviation: number;
}

/**
 * Da a cada foto las mismas medias por canal que la referencia (la primera). Sin balance de
 * blancos ni exposición fijos (en Android, VisionCamera no permite fijar el balance), el móvil
 * puede retocarlos entre foto y foto; al fusionar, esas diferencias se verían como manchas de
 * color donde cada foto pesa más. Es una ganancia por canal y foto, la misma en toda la foto.
 */
export function equalizeFrameColorGains(frames: readonly Uint8Array[], size: number): ColorGainEqualization {
  if (frames.length === 0) return { frames: [], largestGainDeviation: 0 };
  const referenceMeans = centralChannelMeans(frames[0]!, size);
  let largestGainDeviation = 0;
  const equalizedFrames = frames.map((framePixels, frameIndex) => {
    if (frameIndex === 0) return framePixels;
    const frameMeans = centralChannelMeans(framePixels, size);
    const channelGains = frameMeans.map((frameMean, channelIndex) => (frameMean > 0 ? referenceMeans[channelIndex]! / frameMean : 1));
    const frameDeviation = Math.max(...channelGains.map((channelGain) => Math.abs(channelGain - 1)));
    largestGainDeviation = Math.max(largestGainDeviation, frameDeviation);
    if (frameDeviation < negligibleGainDeviation) return framePixels;
    const [redGain, greenGain, blueGain] = channelGains as [number, number, number];
    const equalizedPixels = new Uint8Array(framePixels.length);
    for (let pixelOffset = 0; pixelOffset < framePixels.length; pixelOffset += 3) {
      // Un Uint8Array trunca y da la vuelta (256 → 0) al asignar: se redondea con +0,5 y se recorta a 255.
      const redValue = framePixels[pixelOffset]! * redGain + 0.5;
      const greenValue = framePixels[pixelOffset + 1]! * greenGain + 0.5;
      const blueValue = framePixels[pixelOffset + 2]! * blueGain + 0.5;
      equalizedPixels[pixelOffset] = redValue > 255 ? 255 : redValue;
      equalizedPixels[pixelOffset + 1] = greenValue > 255 ? 255 : greenValue;
      equalizedPixels[pixelOffset + 2] = blueValue > 255 ? 255 : blueValue;
    }
    return equalizedPixels;
  });
  return { frames: equalizedFrames, largestGainDeviation };
}

// ---------------------------------------------------------------------------------------------
// Proceso completo
// ---------------------------------------------------------------------------------------------

export interface LocalSuperResolutionOptions extends SuperResolutionOptions {
  /** false = solo el alineado global (como `superResolveBurst`). */
  useLocalAlignment: boolean;
  /** Igualar las medias de color de todas las fotos con la referencia antes de fusionar. */
  equalizeColorGains?: boolean;
  localAlignment?: Partial<LocalAlignmentOptions>;
}

export interface SuperResolutionStageTimings {
  selectionMilliseconds: number;
  globalAlignmentMilliseconds: number;
  localAlignmentMilliseconds: number;
  mergeMilliseconds: number;
}

export interface LocalSuperResolutionResult extends SuperResolutionResult {
  /** Fotogramas en los que se aplicó el campo local (0 si no se pidió o no había textura). */
  locallyAlignedFrameCount: number;
  alignmentPointCount: number;
  /**
   * Mayor diferencia (px) entre el desplazamiento local y el global dentro del recorte, media de
   * los fotogramas: cuánto se equivocaría el alineado solo global en la peor zona.
   */
  meanMaximumLocalCorrectionPixels: number;
  /** Giro medio (grados, en valor absoluto) que ha medido el afín. */
  meanRotationDegrees: number;
  /** Mayor corrección de color aplicada a una foto (0 si no se pidió). */
  largestColorGainDeviation: number;
  stageTimings: SuperResolutionStageTimings;
}

function meanOf(values: Float32Array): number {
  let valueSum = 0;
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) valueSum += values[valueIndex]!;
  return values.length > 0 ? valueSum / values.length : 0;
}

function scaledToMean(luminance: Float32Array, referenceMean: number): Float32Array {
  const luminanceMean = meanOf(luminance);
  const brightnessGain = luminanceMean > 0 ? referenceMean / luminanceMean : 1;
  const matchedLuminance = new Float32Array(luminance.length);
  for (let valueIndex = 0; valueIndex < luminance.length; valueIndex++) {
    matchedLuminance[valueIndex] = luminance[valueIndex]! * brightnessGain;
  }
  return matchedLuminance;
}

/** Mayor |campo − global| en el recorte (mirando los nodos de la rejilla). */
function maximumFieldMagnitude(field: DisplacementField): number {
  let largestMagnitude = 0;
  for (let nodeIndex = 0; nodeIndex < field.shiftX.length; nodeIndex++) {
    largestMagnitude = Math.max(largestMagnitude, Math.hypot(field.shiftX[nodeIndex]!, field.shiftY[nodeIndex]!));
  }
  return largestMagnitude;
}

/**
 * Proceso de `superResolveBurst` con alineado por zonas: elige la fracción más nítida, la alinea
 * con la mejor (global y, si se pide, por zonas) y la fusiona en la rejilla fina.
 */
export function superResolveBurstWithLocalAlignment(
  frames: readonly Uint8Array[],
  size: number,
  options: LocalSuperResolutionOptions,
  now: () => number = Date.now,
): LocalSuperResolutionResult {
  if (frames.length === 0) throw new Error('No hay fotogramas para fusionar');
  const selectionStartTime = now();
  const sharpnessScores = frames.map((framePixels) => measureCropSharpness(framePixels, size));
  const rankedFrameIndices = frames
    .map((_framePixels, frameIndex) => frameIndex)
    .sort((firstIndex, secondIndex) => sharpnessScores[secondIndex]! - sharpnessScores[firstIndex]!);
  const usedFrameCount = Math.max(1, Math.round(frames.length * options.keptFraction));
  const selectedFrames = rankedFrameIndices.slice(0, usedFrameCount).map((frameIndex) => frames[frameIndex]!);
  const colorEqualization = options.equalizeColorGains
    ? equalizeFrameColorGains(selectedFrames, size)
    : { frames: selectedFrames, largestGainDeviation: 0 };
  const usedFrames = colorEqualization.frames;
  const referenceFrame = usedFrames[0]!;
  const referenceLuminance = computeLuminance(referenceFrame, size);
  const referenceMean = meanOf(referenceLuminance);
  const selectionMilliseconds = now() - selectionStartTime;

  const globalAlignmentStartTime = now();
  const alignFrame = createFrameAligner(referenceLuminance, size, options.maximumShiftPixels);
  const matchedLuminances: Float32Array[] = [referenceLuminance];
  const frameOffsets: FrameOffset[] = [{ offsetX: 0, offsetY: 0 }];
  for (const framePixels of usedFrames.slice(1)) {
    const matchedLuminance = scaledToMean(computeLuminance(framePixels, size), referenceMean);
    matchedLuminances.push(matchedLuminance);
    frameOffsets.push(alignFrame(matchedLuminance));
  }
  const globalAlignmentMilliseconds = now() - globalAlignmentStartTime;

  const localAlignmentStartTime = now();
  const localOptions = { ...defaultLocalAlignmentOptions(size), ...options.localAlignment };
  const referenceImage: GrayImage = { width: size, height: size, values: referenceLuminance };
  const alignmentPoints =
    options.useLocalAlignment && usedFrames.length > 1
      ? findAlignmentPoints(
          referenceImage,
          localOptions.pointSpacingPixels,
          localOptions.patchRadiusPixels,
          localOptions.coarseSearchRadiusPixels,
        )
      : [];
  const displacements: (DenseDisplacement | null)[] = [null];
  const robustnessMaps: (Float32Array | null)[] = [null];
  let locallyAlignedFrameCount = 0;
  let maximumCorrectionSum = 0;
  let rotationSum = 0;
  for (let usedIndex = 1; usedIndex < usedFrames.length; usedIndex++) {
    const frameImage: GrayImage = { width: size, height: size, values: matchedLuminances[usedIndex]! };
    const globalOffset = frameOffsets[usedIndex]!;
    const localAlignment =
      alignmentPoints.length > 0
        ? measureFrameLocalAlignment(referenceImage, frameImage, globalOffset, alignmentPoints, localOptions)
        : null;
    if (localAlignment) {
      locallyAlignedFrameCount++;
      maximumCorrectionSum += maximumFieldMagnitude(localAlignment.field);
      rotationSum += Math.abs(((localAlignment.affine.yFromX - localAlignment.affine.xFromY) / 2) * (180 / Math.PI));
    }
    const displacement = denseDisplacement(size, globalOffset, localAlignment?.field);
    displacements.push(displacement);
    const warpedLuminance = warpWithDisplacement(frameImage, displacement).values;
    robustnessMaps.push(robustnessMapForWarpedFrame(referenceLuminance, warpedLuminance, displacement, size));
  }
  const localAlignmentMilliseconds = now() - localAlignmentStartTime;

  const mergeStartTime = now();
  const mergedImage = mergeFramesWithDisplacements(usedFrames, displacements, robustnessMaps, size, {
    scale: options.scale,
    kernelSigmaPixels: kernelSigmaForFrameCount(usedFrameCount),
  });
  const mergeMilliseconds = now() - mergeStartTime;

  const shiftMagnitudes = frameOffsets.slice(1).map(({ offsetX, offsetY }) => Math.hypot(offsetX, offsetY));
  return {
    image: mergedImage,
    singleFrameImage: upscaleFrameBilinear(referenceFrame, size, options.scale),
    usedFrameCount,
    referenceFrameIndex: rankedFrameIndices[0]!,
    frameOffsets,
    meanShiftPixels:
      shiftMagnitudes.length > 0
        ? shiftMagnitudes.reduce((shiftSum, shiftMagnitude) => shiftSum + shiftMagnitude, 0) / shiftMagnitudes.length
        : 0,
    locallyAlignedFrameCount,
    alignmentPointCount: alignmentPoints.length,
    meanMaximumLocalCorrectionPixels: locallyAlignedFrameCount > 0 ? maximumCorrectionSum / locallyAlignedFrameCount : 0,
    meanRotationDegrees: locallyAlignedFrameCount > 0 ? rotationSum / locallyAlignedFrameCount : 0,
    largestColorGainDeviation: colorEqualization.largestGainDeviation,
    stageTimings: { selectionMilliseconds, globalAlignmentMilliseconds, localAlignmentMilliseconds, mergeMilliseconds },
  };
}
