/**
 * Alineado con escala, giro y traslación (una «semejanza») entre dos fotos de la misma escena.
 *
 * Para el apilado de enfoque: al mover el enfoque, el objetivo cambia un poco el ángulo de visión
 * («focus breathing»): la foto enfocada cerca sale un 0,5-3 % más grande o más pequeña que la
 * enfocada lejos. Una traslación sola (como en el superzoom) dejaría los bordes descolocados
 * varios píxeles. Aquí el modelo es
 *
 *     q − c = z · (p − c) + o,
 *
 * con p en la referencia, q en la foto, c el centro de la imagen, z = a + b·i (escala |z| y
 * giro arg z, como número complejo) y o = (offsetX, offsetY) la traslación.
 *
 * Método: pirámide de resoluciones de las dos luminancias algo suavizadas (el suavizado quita el
 * ruido y reduce la diferencia de nitidez entre fotos con distinto enfoque), búsqueda entera de la
 * traslación en el nivel más grueso y, de grueso a fino, Gauss-Newton sobre los cuatro parámetros
 * (con los gradientes de la referencia, válido cerca de la solución y mucho más barato).
 *
 * Módulo puro: sin React ni React Native. Bucles sin llamadas por píxel (Hermes, sin JIT).
 */

import { smoothWithBinomial3 } from './fastPlaneBlur';
import type { GrayImage } from './grayImage';

export interface SimilarityTransform {
  /** Parte real de z: escala · cos(giro). */
  scaleCosine: number;
  /** Parte imaginaria de z: escala · sen(giro). */
  scaleSine: number;
  offsetX: number;
  offsetY: number;
}

export const identitySimilarity: SimilarityTransform = { scaleCosine: 1, scaleSine: 0, offsetX: 0, offsetY: 0 };

export function similarityScale(transform: SimilarityTransform): number {
  return Math.hypot(transform.scaleCosine, transform.scaleSine);
}

export function similarityRotationDegrees(transform: SimilarityTransform): number {
  return (Math.atan2(transform.scaleSine, transform.scaleCosine) * 180) / Math.PI;
}

/**
 * Composición: `first` lleva de A a B y `second` de B a C (las dos alrededor del mismo centro);
 * el resultado lleva de A a C.
 */
export function composeSimilarity(first: SimilarityTransform, second: SimilarityTransform): SimilarityTransform {
  return {
    scaleCosine: second.scaleCosine * first.scaleCosine - second.scaleSine * first.scaleSine,
    scaleSine: second.scaleCosine * first.scaleSine + second.scaleSine * first.scaleCosine,
    offsetX: second.scaleCosine * first.offsetX - second.scaleSine * first.offsetY + second.offsetX,
    offsetY: second.scaleSine * first.offsetX + second.scaleCosine * first.offsetY + second.offsetY,
  };
}

/** Posición en la foto de lo que en la referencia está en (x, y). */
export function mapPointWithSimilarity(
  transform: SimilarityTransform,
  width: number,
  height: number,
  positionX: number,
  positionY: number,
): { x: number; y: number } {
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const relativeX = positionX - centerX;
  const relativeY = positionY - centerY;
  return {
    x: centerX + transform.scaleCosine * relativeX - transform.scaleSine * relativeY + transform.offsetX,
    y: centerY + transform.scaleSine * relativeX + transform.scaleCosine * relativeY + transform.offsetY,
  };
}

export interface SimilarityAlignmentOptions {
  /** Mayor traslación que se busca, en píxeles de la imagen completa. */
  maximumShiftPixels: number;
  /** false: solo escala y traslación (sin giro). */
  estimateRotation: boolean;
}

export const defaultSimilarityAlignmentOptions: SimilarityAlignmentOptions = {
  maximumShiftPixels: 48,
  estimateRotation: true,
};

export interface SimilarityAlignmentResult {
  transform: SimilarityTransform;
  /** Diferencia cuadrática media que queda tras alinear (en niveles de luminancia suavizada). */
  residualRootMeanSquare: number;
}

interface PyramidLevel {
  width: number;
  height: number;
  values: Float32Array;
}

/** El nivel más grueso de la pirámide tiene al menos este lado. */
const minimumPyramidSide = 40;
const gaussNewtonIterationsPerLevel = 8;
/** Paso por debajo del cual se da por convergido (px en el nivel). */
const convergencePixels = 0.004;

/** Mitad de resolución con el núcleo 1-2-1 (bordes repetidos). */
function downsampleLevel(level: PyramidLevel): PyramidLevel {
  const smoothedValues = smoothWithBinomial3(level.values, level.width, level.height);
  const halfWidth = Math.floor(level.width / 2);
  const halfHeight = Math.floor(level.height / 2);
  const halfValues = new Float32Array(halfWidth * halfHeight);
  for (let rowIndex = 0; rowIndex < halfHeight; rowIndex++) {
    const sourceRowStart = 2 * rowIndex * level.width;
    for (let columnIndex = 0; columnIndex < halfWidth; columnIndex++) {
      halfValues[rowIndex * halfWidth + columnIndex] = smoothedValues[sourceRowStart + 2 * columnIndex]!;
    }
  }
  return { width: halfWidth, height: halfHeight, values: halfValues };
}

function buildLevels(image: GrayImage): PyramidLevel[] {
  const levels: PyramidLevel[] = [{ width: image.width, height: image.height, values: image.values }];
  let coarsestLevel = levels[0]!;
  while (Math.min(coarsestLevel.width, coarsestLevel.height) / 2 >= minimumPyramidSide) {
    coarsestLevel = downsampleLevel(coarsestLevel);
    levels.push(coarsestLevel);
  }
  return levels;
}

function meanOfPlane(values: Float32Array): number {
  let valueSum = 0;
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) valueSum += values[valueIndex]!;
  return values.length > 0 ? valueSum / values.length : 0;
}

/** Diferencia cuadrática media con la foto trasladada un número entero de píxeles. */
function integerShiftCost(reference: PyramidLevel, target: PyramidLevel, shiftX: number, shiftY: number, margin: number): number {
  const { width, height } = reference;
  let squaredDifferenceSum = 0;
  let sampleCount = 0;
  for (let rowIndex = margin; rowIndex < height - margin; rowIndex++) {
    const targetRow = rowIndex + shiftY;
    if (targetRow < 0 || targetRow >= height) continue;
    for (let columnIndex = margin; columnIndex < width - margin; columnIndex++) {
      const targetColumn = columnIndex + shiftX;
      if (targetColumn < 0 || targetColumn >= width) continue;
      const difference = reference.values[rowIndex * width + columnIndex]! - target.values[targetRow * width + targetColumn]!;
      squaredDifferenceSum += difference * difference;
      sampleCount++;
    }
  }
  return sampleCount > 0 ? squaredDifferenceSum / sampleCount : Number.POSITIVE_INFINITY;
}

/** Resuelve un sistema lineal pequeño (eliminación gaussiana con pivote); null si es singular. */
function solveLinearSystem(matrix: number[][], rightHandSide: number[]): number[] | null {
  const dimension = rightHandSide.length;
  const augmented = matrix.map((matrixRow, rowIndex) => [...matrixRow, rightHandSide[rowIndex]!]);
  for (let pivotIndex = 0; pivotIndex < dimension; pivotIndex++) {
    let bestRow = pivotIndex;
    for (let rowIndex = pivotIndex + 1; rowIndex < dimension; rowIndex++) {
      if (Math.abs(augmented[rowIndex]![pivotIndex]!) > Math.abs(augmented[bestRow]![pivotIndex]!)) bestRow = rowIndex;
    }
    if (Math.abs(augmented[bestRow]![pivotIndex]!) < 1e-12) return null;
    [augmented[pivotIndex], augmented[bestRow]] = [augmented[bestRow]!, augmented[pivotIndex]!];
    for (let rowIndex = pivotIndex + 1; rowIndex < dimension; rowIndex++) {
      const eliminationFactor = augmented[rowIndex]![pivotIndex]! / augmented[pivotIndex]![pivotIndex]!;
      for (let columnIndex = pivotIndex; columnIndex <= dimension; columnIndex++) {
        augmented[rowIndex]![columnIndex] = augmented[rowIndex]![columnIndex]! - eliminationFactor * augmented[pivotIndex]![columnIndex]!;
      }
    }
  }
  const solution = new Array<number>(dimension).fill(0);
  for (let rowIndex = dimension - 1; rowIndex >= 0; rowIndex--) {
    let remainder = augmented[rowIndex]![dimension]!;
    for (let columnIndex = rowIndex + 1; columnIndex < dimension; columnIndex++) {
      remainder -= augmented[rowIndex]![columnIndex]! * solution[columnIndex]!;
    }
    solution[rowIndex] = remainder / augmented[rowIndex]![rowIndex]!;
  }
  return solution;
}

/**
 * Una iteración de Gauss-Newton en un nivel. La transformación va en coordenadas del nivel
 * (centro y traslación ya divididos por 2^nivel). Devuelve la nueva y la diferencia cuadrática
 * media antes del paso, o null si no hay puntos o el sistema es singular.
 */
function gaussNewtonStep(
  reference: PyramidLevel,
  target: PyramidLevel,
  centerX: number,
  centerY: number,
  transform: SimilarityTransform,
  sampleStride: number,
  estimateRotation: boolean,
): { transform: SimilarityTransform; meanSquaredResidual: number; stepPixels: number } | null {
  const { width, height } = reference;
  const referenceValues = reference.values;
  const targetValues = target.values;
  const parameterCount = estimateRotation ? 4 : 3;
  const normalMatrix = Array.from({ length: parameterCount }, () => new Array<number>(parameterCount).fill(0));
  const normalVector = new Array<number>(parameterCount).fill(0);
  const jacobianRow = new Array<number>(parameterCount).fill(0);
  const { scaleCosine, scaleSine, offsetX, offsetY } = transform;
  // Semilado: cuánto mueve la esquina un cambio de la escala (para frenar y para parar).
  const halfSide = Math.max(width, height) / 2;
  let squaredResidualSum = 0;
  let sampleCount = 0;
  const lastTopLeftColumn = width - 2;
  const lastTopLeftRow = height - 2;
  for (let rowIndex = 1; rowIndex < height - 1; rowIndex += sampleStride) {
    const relativeY = rowIndex - centerY;
    for (let columnIndex = 1; columnIndex < width - 1; columnIndex += sampleStride) {
      const relativeX = columnIndex - centerX;
      const targetX = centerX + scaleCosine * relativeX - scaleSine * relativeY + offsetX;
      const targetY = centerY + scaleSine * relativeX + scaleCosine * relativeY + offsetY;
      if (targetX < 0 || targetY < 0 || targetX > width - 1 || targetY > height - 1) continue;
      let leftColumn = targetX | 0;
      if (leftColumn > lastTopLeftColumn) leftColumn = lastTopLeftColumn;
      let topRow = targetY | 0;
      if (topRow > lastTopLeftRow) topRow = lastTopLeftRow;
      const horizontalWeight = targetX - leftColumn;
      const verticalWeight = targetY - topRow;
      const topLeftIndex = topRow * width + leftColumn;
      const topValue = targetValues[topLeftIndex]! + horizontalWeight * (targetValues[topLeftIndex + 1]! - targetValues[topLeftIndex]!);
      const bottomValue =
        targetValues[topLeftIndex + width]! +
        horizontalWeight * (targetValues[topLeftIndex + width + 1]! - targetValues[topLeftIndex + width]!);
      const referenceIndex = rowIndex * width + columnIndex;
      const residual = referenceValues[referenceIndex]! - (topValue + verticalWeight * (bottomValue - topValue));
      const gradientX = (referenceValues[referenceIndex + 1]! - referenceValues[referenceIndex - 1]!) / 2;
      const gradientY = (referenceValues[referenceIndex + width]! - referenceValues[referenceIndex - width]!) / 2;
      // Derivadas de q respecto a (a, b, oX, oY): (u), (−uY, uX), (1, 0), (0, 1), con u = p − c.
      jacobianRow[0] = gradientX * relativeX + gradientY * relativeY;
      if (estimateRotation) {
        jacobianRow[1] = -gradientX * relativeY + gradientY * relativeX;
        jacobianRow[2] = gradientX;
        jacobianRow[3] = gradientY;
      } else {
        jacobianRow[1] = gradientX;
        jacobianRow[2] = gradientY;
      }
      for (let firstIndex = 0; firstIndex < parameterCount; firstIndex++) {
        const firstValue = jacobianRow[firstIndex]!;
        normalVector[firstIndex] = normalVector[firstIndex]! + firstValue * residual;
        const normalRow = normalMatrix[firstIndex]!;
        for (let secondIndex = firstIndex; secondIndex < parameterCount; secondIndex++) {
          normalRow[secondIndex] = normalRow[secondIndex]! + firstValue * jacobianRow[secondIndex]!;
        }
      }
      squaredResidualSum += residual * residual;
      sampleCount++;
    }
  }
  if (sampleCount < 16) return null;
  for (let firstIndex = 0; firstIndex < parameterCount; firstIndex++) {
    for (let secondIndex = 0; secondIndex < firstIndex; secondIndex++) {
      normalMatrix[firstIndex]![secondIndex] = normalMatrix[secondIndex]![firstIndex]!;
    }
  }
  const parameterStep = solveLinearSystem(normalMatrix, normalVector);
  if (!parameterStep) return null;
  const scaleCosineStep = parameterStep[0]!;
  const scaleSineStep = estimateRotation ? parameterStep[1]! : 0;
  const offsetXStep = parameterStep[estimateRotation ? 2 : 1]!;
  const offsetYStep = parameterStep[estimateRotation ? 3 : 2]!;
  // Cuánto se mueve la esquina con este paso: sirve para frenar pasos locos y para parar.
  const stepPixels =
    Math.hypot(offsetXStep, offsetYStep) + Math.hypot(scaleCosineStep, scaleSineStep) * halfSide;
  const dampingFactor = stepPixels > 2 ? 2 / stepPixels : 1;
  return {
    transform: {
      scaleCosine: scaleCosine + dampingFactor * scaleCosineStep,
      scaleSine: scaleSine + dampingFactor * scaleSineStep,
      offsetX: offsetX + dampingFactor * offsetXStep,
      offsetY: offsetY + dampingFactor * offsetYStep,
    },
    meanSquaredResidual: squaredResidualSum / sampleCount,
    stepPixels: stepPixels * dampingFactor,
  };
}

/** Pasa la transformación de píxeles de la imagen completa a los de un nivel, o al revés. */
function scaleTransformOffsets(transform: SimilarityTransform, factor: number): SimilarityTransform {
  return { ...transform, offsetX: transform.offsetX * factor, offsetY: transform.offsetY * factor };
}

/**
 * Prepara el alineado con una referencia fija (su pirámide se calcula una vez). Las imágenes deben
 * tener el mismo tamaño; el brillo medio de cada foto se iguala al de la referencia.
 */
export function createSimilarityAligner(reference: GrayImage, options: SimilarityAlignmentOptions = defaultSimilarityAlignmentOptions) {
  const referenceMean = meanOfPlane(reference.values);
  const referenceLevels = buildLevels({ ...reference, values: smoothWithBinomial3(reference.values, reference.width, reference.height) });
  const coarsestLevelIndex = referenceLevels.length - 1;

  return (target: GrayImage, initialTransform?: SimilarityTransform): SimilarityAlignmentResult => {
    if (target.width !== reference.width || target.height !== reference.height) {
      throw new Error('La foto y la referencia deben medir lo mismo');
    }
    const targetMean = meanOfPlane(target.values);
    const brightnessGain = targetMean > 0 ? referenceMean / targetMean : 1;
    const smoothedTarget = smoothWithBinomial3(target.values, target.width, target.height);
    if (brightnessGain !== 1) {
      for (let valueIndex = 0; valueIndex < smoothedTarget.length; valueIndex++) {
        smoothedTarget[valueIndex] = smoothedTarget[valueIndex]! * brightnessGain;
      }
    }
    const targetLevels = buildLevels({ width: target.width, height: target.height, values: smoothedTarget });

    let transform: SimilarityTransform;
    if (initialTransform) {
      transform = initialTransform;
    } else {
      // Búsqueda entera de la traslación en el nivel más grueso.
      const coarsestReference = referenceLevels[coarsestLevelIndex]!;
      const coarsestTarget = targetLevels[coarsestLevelIndex]!;
      const levelFactor = 2 ** coarsestLevelIndex;
      const searchRadius = Math.max(
        1,
        Math.min(
          Math.ceil(options.maximumShiftPixels / levelFactor),
          Math.floor(Math.min(coarsestReference.width, coarsestReference.height) / 4),
        ),
      );
      let bestShiftX = 0;
      let bestShiftY = 0;
      let bestCost = Number.POSITIVE_INFINITY;
      for (let candidateY = -searchRadius; candidateY <= searchRadius; candidateY++) {
        for (let candidateX = -searchRadius; candidateX <= searchRadius; candidateX++) {
          const cost = integerShiftCost(coarsestReference, coarsestTarget, candidateX, candidateY, searchRadius);
          if (cost < bestCost) {
            bestCost = cost;
            bestShiftX = candidateX;
            bestShiftY = candidateY;
          }
        }
      }
      transform = { ...identitySimilarity, offsetX: bestShiftX * levelFactor, offsetY: bestShiftY * levelFactor };
    }

    let residualRootMeanSquare = Number.POSITIVE_INFINITY;
    for (let levelIndex = coarsestLevelIndex; levelIndex >= 0; levelIndex--) {
      const referenceLevel = referenceLevels[levelIndex]!;
      const targetLevel = targetLevels[levelIndex]!;
      const levelFactor = 2 ** levelIndex;
      const centerX = (reference.width - 1) / 2 / levelFactor;
      const centerY = (reference.height - 1) / 2 / levelFactor;
      // En los niveles finos basta un punto de cada pocos: hay de sobra para cuatro parámetros.
      const sampleStride = levelIndex === 0 ? 3 : levelIndex === 1 ? 2 : 1;
      let levelTransform = scaleTransformOffsets(transform, 1 / levelFactor);
      for (let iterationIndex = 0; iterationIndex < gaussNewtonIterationsPerLevel; iterationIndex++) {
        const stepResult = gaussNewtonStep(
          referenceLevel,
          targetLevel,
          centerX,
          centerY,
          levelTransform,
          sampleStride,
          options.estimateRotation,
        );
        if (!stepResult) break;
        levelTransform = stepResult.transform;
        if (levelIndex === 0) residualRootMeanSquare = Math.sqrt(stepResult.meanSquaredResidual);
        if (stepResult.stepPixels < convergencePixels) break;
      }
      transform = scaleTransformOffsets(levelTransform, levelFactor);
    }
    return { transform, residualRootMeanSquare };
  };
}

/**
 * Remuestrea un plano en la geometría de la referencia (bilineal): el píxel p toma el valor del
 * plano en T(p). Fuera de la imagen se pone `outsideValue` (null: se repite el borde).
 */
export function warpPlaneWithSimilarity(
  values: Float32Array,
  width: number,
  height: number,
  transform: SimilarityTransform,
  outsideValue: number | null,
): Float32Array {
  const warpedValues = new Float32Array(width * height);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const { scaleCosine, scaleSine, offsetX, offsetY } = transform;
  const lastTopLeftColumn = width - 2;
  const lastTopLeftRow = height - 2;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const relativeY = rowIndex - centerY;
    // Se avanza por la fila sumando: T es lineal.
    let sourceX = centerX - scaleCosine * centerX - scaleSine * relativeY + offsetX;
    let sourceY = centerY - scaleSine * centerX + scaleCosine * relativeY + offsetY;
    for (let columnIndex = 0; columnIndex < width; columnIndex++, sourceX += scaleCosine, sourceY += scaleSine) {
      const pixelIndex = rowIndex * width + columnIndex;
      if (outsideValue !== null && (sourceX < -0.5 || sourceY < -0.5 || sourceX > width - 0.5 || sourceY > height - 0.5)) {
        warpedValues[pixelIndex] = outsideValue;
        continue;
      }
      const clampedX = sourceX < 0 ? 0 : sourceX > width - 1 ? width - 1 : sourceX;
      const clampedY = sourceY < 0 ? 0 : sourceY > height - 1 ? height - 1 : sourceY;
      let leftColumn = clampedX | 0;
      if (leftColumn > lastTopLeftColumn) leftColumn = lastTopLeftColumn;
      let topRow = clampedY | 0;
      if (topRow > lastTopLeftRow) topRow = lastTopLeftRow;
      const horizontalWeight = clampedX - leftColumn;
      const verticalWeight = clampedY - topRow;
      const topLeftIndex = topRow * width + leftColumn;
      const topValue = values[topLeftIndex]! + horizontalWeight * (values[topLeftIndex + 1]! - values[topLeftIndex]!);
      const bottomValue =
        values[topLeftIndex + width]! + horizontalWeight * (values[topLeftIndex + width + 1]! - values[topLeftIndex + width]!);
      warpedValues[pixelIndex] = topValue + verticalWeight * (bottomValue - topValue);
    }
  }
  return warpedValues;
}

/**
 * Como `warpPlaneWithSimilarity` (bordes repetidos), pero con interpolación bicúbica
 * (Catmull-Rom): la bilineal, con desplazamientos de medio píxel, se come un tercio del detalle
 * más fino, justo el que busca el apilado de enfoque. Cuesta unas cuatro veces más.
 */
export function warpPlaneWithSimilarityBicubic(
  values: Float32Array,
  width: number,
  height: number,
  transform: SimilarityTransform,
): Float32Array {
  const warpedValues = new Float32Array(width * height);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const { scaleCosine, scaleSine, offsetX, offsetY } = transform;
  const lastColumn = width - 1;
  const lastRow = height - 1;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const relativeY = rowIndex - centerY;
    let sourceX = centerX - scaleCosine * centerX - scaleSine * relativeY + offsetX;
    let sourceY = centerY - scaleSine * centerX + scaleCosine * relativeY + offsetY;
    for (let columnIndex = 0; columnIndex < width; columnIndex++, sourceX += scaleCosine, sourceY += scaleSine) {
      const clampedX = sourceX < 0 ? 0 : sourceX > lastColumn ? lastColumn : sourceX;
      const clampedY = sourceY < 0 ? 0 : sourceY > lastRow ? lastRow : sourceY;
      const baseColumn = Math.floor(clampedX);
      const baseRow = Math.floor(clampedY);
      const fractionX = clampedX - baseColumn;
      const fractionY = clampedY - baseRow;
      // Pesos de Catmull-Rom para las cuatro columnas y las cuatro filas vecinas.
      const fractionXSquared = fractionX * fractionX;
      const fractionXCubed = fractionXSquared * fractionX;
      const columnWeight0 = 0.5 * (-fractionXCubed + 2 * fractionXSquared - fractionX);
      const columnWeight1 = 0.5 * (3 * fractionXCubed - 5 * fractionXSquared + 2);
      const columnWeight2 = 0.5 * (-3 * fractionXCubed + 4 * fractionXSquared + fractionX);
      const columnWeight3 = 0.5 * (fractionXCubed - fractionXSquared);
      const fractionYSquared = fractionY * fractionY;
      const fractionYCubed = fractionYSquared * fractionY;
      const rowWeight0 = 0.5 * (-fractionYCubed + 2 * fractionYSquared - fractionY);
      const rowWeight1 = 0.5 * (3 * fractionYCubed - 5 * fractionYSquared + 2);
      const rowWeight2 = 0.5 * (-3 * fractionYCubed + 4 * fractionYSquared + fractionY);
      const rowWeight3 = 0.5 * (fractionYCubed - fractionYSquared);
      const column0 = baseColumn - 1 < 0 ? 0 : baseColumn - 1;
      const column2 = baseColumn + 1 > lastColumn ? lastColumn : baseColumn + 1;
      const column3 = baseColumn + 2 > lastColumn ? lastColumn : baseColumn + 2;
      const row0Start = (baseRow - 1 < 0 ? 0 : baseRow - 1) * width;
      const row1Start = baseRow * width;
      const row2Start = (baseRow + 1 > lastRow ? lastRow : baseRow + 1) * width;
      const row3Start = (baseRow + 2 > lastRow ? lastRow : baseRow + 2) * width;
      const rowValue0 =
        columnWeight0 * values[row0Start + column0]! + columnWeight1 * values[row0Start + baseColumn]! +
        columnWeight2 * values[row0Start + column2]! + columnWeight3 * values[row0Start + column3]!;
      const rowValue1 =
        columnWeight0 * values[row1Start + column0]! + columnWeight1 * values[row1Start + baseColumn]! +
        columnWeight2 * values[row1Start + column2]! + columnWeight3 * values[row1Start + column3]!;
      const rowValue2 =
        columnWeight0 * values[row2Start + column0]! + columnWeight1 * values[row2Start + baseColumn]! +
        columnWeight2 * values[row2Start + column2]! + columnWeight3 * values[row2Start + column3]!;
      const rowValue3 =
        columnWeight0 * values[row3Start + column0]! + columnWeight1 * values[row3Start + baseColumn]! +
        columnWeight2 * values[row3Start + column2]! + columnWeight3 * values[row3Start + column3]!;
      warpedValues[rowIndex * width + columnIndex] = rowWeight0 * rowValue0 + rowWeight1 * rowValue1 + rowWeight2 * rowValue2 + rowWeight3 * rowValue3;
    }
  }
  return warpedValues;
}
