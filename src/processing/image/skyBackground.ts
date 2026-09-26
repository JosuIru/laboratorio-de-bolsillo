/**
 * Fondo del cielo y estirado del histograma para fotos de estrellas.
 *
 * - Fondo: el resplandor de las farolas, la Luna o el crepúsculo deja un gradiente suave que se
 *   come las estrellas débiles al estirar. Se ajusta un polinomio de grado bajo en (x, y) a los
 *   niveles de fondo por celdas (mediana recortada: las estrellas no cuentan) y se descartan en
 *   varias rondas las celdas que no encajan (una celda con una estrella brillante, un árbol, un
 *   tejado). Se resta a toda la imagen.
 * - Estirado asinh (Lupton et al. 2004): lineal para lo débil y logarítmico para lo brillante, de
 *   modo que el fondo y las estrellas débiles se ven sin quemar las brillantes.
 *
 * Módulo puro: sin React ni React Native.
 */
import type { GrayImage } from './grayImage';
import { estimateBackgroundMesh, robustLevelAndNoise } from './starDetection';

export interface SkyBackgroundModel {
  /** Grado del polinomio (1-3). */
  degree: number;
  coefficients: Float64Array;
  width: number;
  height: number;
  /** Celdas que quedaron en el ajuste / celdas totales. */
  keptCellFraction: number;
}

export interface SkyBackgroundSubtraction {
  /** Imagen menos el fondo (el cielo queda alrededor de 0). */
  flattenedImage: GrayImage;
  model: SkyBackgroundModel;
  /** Diferencia entre el fondo más claro y el más oscuro del modelo: cuánto gradiente había. */
  gradientRangeLevels: number;
  /** Ruido del cielo (σ) tras restar el fondo. */
  backgroundNoise: number;
}

export interface SkyBackgroundOptions {
  degree: number;
  cellSize: number;
  /** Las celdas a más de κ·σ del ajuste se descartan en la ronda siguiente. */
  rejectionKappa: number;
}

export const defaultSkyBackgroundOptions: SkyBackgroundOptions = { degree: 2, cellSize: 48, rejectionKappa: 2.5 };

/** Términos xⁱ·yʲ con i + j ≤ grado, en coordenadas normalizadas a [−1, 1]. */
function polynomialTerms(normalizedX: number, normalizedY: number, degree: number, terms: Float64Array): void {
  let termIndex = 0;
  for (let totalPower = 0; totalPower <= degree; totalPower++) {
    for (let powerOfY = 0; powerOfY <= totalPower; powerOfY++) {
      terms[termIndex++] = normalizedX ** (totalPower - powerOfY) * normalizedY ** powerOfY;
    }
  }
}

function termCountForDegree(degree: number): number {
  return ((degree + 1) * (degree + 2)) / 2;
}

/** Resuelve A·x = b (A cuadrada) por eliminación gaussiana con pivote parcial. */
function solveLinearSystem(matrix: Float64Array, rightHandSide: Float64Array, size: number): Float64Array<ArrayBuffer> | null {
  const augmented = new Float64Array(size * (size + 1));
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      augmented[rowIndex * (size + 1) + columnIndex] = matrix[rowIndex * size + columnIndex]!;
    }
    augmented[rowIndex * (size + 1) + size] = rightHandSide[rowIndex]!;
  }
  for (let pivotColumn = 0; pivotColumn < size; pivotColumn++) {
    let pivotRow = pivotColumn;
    for (let rowIndex = pivotColumn + 1; rowIndex < size; rowIndex++) {
      if (Math.abs(augmented[rowIndex * (size + 1) + pivotColumn]!) > Math.abs(augmented[pivotRow * (size + 1) + pivotColumn]!)) {
        pivotRow = rowIndex;
      }
    }
    const pivotValue = augmented[pivotRow * (size + 1) + pivotColumn]!;
    if (Math.abs(pivotValue) < 1e-12) return null;
    if (pivotRow !== pivotColumn) {
      for (let columnIndex = 0; columnIndex <= size; columnIndex++) {
        const swappedValue = augmented[pivotRow * (size + 1) + columnIndex]!;
        augmented[pivotRow * (size + 1) + columnIndex] = augmented[pivotColumn * (size + 1) + columnIndex]!;
        augmented[pivotColumn * (size + 1) + columnIndex] = swappedValue;
      }
    }
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      if (rowIndex === pivotColumn) continue;
      const eliminationFactor = augmented[rowIndex * (size + 1) + pivotColumn]! / pivotValue;
      if (eliminationFactor === 0) continue;
      for (let columnIndex = pivotColumn; columnIndex <= size; columnIndex++) {
        augmented[rowIndex * (size + 1) + columnIndex] =
          augmented[rowIndex * (size + 1) + columnIndex]! - eliminationFactor * augmented[pivotColumn * (size + 1) + columnIndex]!;
      }
    }
  }
  const solution = new Float64Array(size);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    solution[rowIndex] = augmented[rowIndex * (size + 1) + size]! / augmented[rowIndex * (size + 1) + rowIndex]!;
  }
  return solution;
}

function normalizedCoordinate(position: number, size: number): number {
  return size > 1 ? (2 * position) / (size - 1) - 1 : 0;
}

/** Valor del modelo de fondo en (x, y). */
export function evaluateSkyBackground(model: SkyBackgroundModel, positionX: number, positionY: number): number {
  const terms = new Float64Array(model.coefficients.length);
  polynomialTerms(normalizedCoordinate(positionX, model.width), normalizedCoordinate(positionY, model.height), model.degree, terms);
  let backgroundValue = 0;
  for (let termIndex = 0; termIndex < terms.length; termIndex++) backgroundValue += model.coefficients[termIndex]! * terms[termIndex]!;
  return backgroundValue;
}

/** Ajusta el polinomio de fondo a la imagen (sin modificarla). */
export function fitSkyBackground(image: GrayImage, backgroundOptions: Partial<SkyBackgroundOptions> = {}): SkyBackgroundModel {
  const options = { ...defaultSkyBackgroundOptions, ...backgroundOptions };
  const { width, height } = image;
  // Sin suavizar la malla: aplanaría el gradiente en los bordes. Las celdas raras las quita el recorte.
  const mesh = estimateBackgroundMesh(image, options.cellSize, false);
  const cellCount = mesh.columnCount * mesh.rowCount;
  // Con pocas celdas no se puede ajustar un grado alto.
  let degree = Math.max(0, Math.min(3, Math.round(options.degree)));
  while (degree > 0 && termCountForDegree(degree) * 2 > cellCount) degree--;
  const termCount = termCountForDegree(degree);

  const cellTerms: Float64Array[] = [];
  const cellLevels: number[] = [];
  for (let meshRow = 0; meshRow < mesh.rowCount; meshRow++) {
    for (let meshColumn = 0; meshColumn < mesh.columnCount; meshColumn++) {
      const centerX = ((meshColumn + 0.5) * width) / mesh.columnCount - 0.5;
      const centerY = ((meshRow + 0.5) * height) / mesh.rowCount - 0.5;
      const terms = new Float64Array(termCount);
      polynomialTerms(normalizedCoordinate(centerX, width), normalizedCoordinate(centerY, height), degree, terms);
      cellTerms.push(terms);
      cellLevels.push(mesh.levels[meshRow * mesh.columnCount + meshColumn]!);
    }
  }

  const isCellKept = new Array<boolean>(cellCount).fill(true);
  let coefficients: Float64Array<ArrayBuffer> = new Float64Array(termCount);
  coefficients[0] = robustLevelAndNoise(cellLevels.slice()).level;
  for (let fittingRound = 0; fittingRound < 4; fittingRound++) {
    const normalMatrix = new Float64Array(termCount * termCount);
    const normalRightHandSide = new Float64Array(termCount);
    let keptCount = 0;
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      if (!isCellKept[cellIndex]) continue;
      keptCount++;
      const terms = cellTerms[cellIndex]!;
      for (let rowIndex = 0; rowIndex < termCount; rowIndex++) {
        normalRightHandSide[rowIndex] = normalRightHandSide[rowIndex]! + terms[rowIndex]! * cellLevels[cellIndex]!;
        for (let columnIndex = 0; columnIndex < termCount; columnIndex++) {
          normalMatrix[rowIndex * termCount + columnIndex] = normalMatrix[rowIndex * termCount + columnIndex]! + terms[rowIndex]! * terms[columnIndex]!;
        }
      }
    }
    if (keptCount < termCount) break;
    const solution = solveLinearSystem(normalMatrix, normalRightHandSide, termCount);
    if (!solution) break;
    coefficients = solution;
    // Residuos y descarte robusto (MAD) de las celdas que no encajan.
    const residuals = cellLevels.map((cellLevel, cellIndex) => {
      let modelValue = 0;
      const terms = cellTerms[cellIndex]!;
      for (let termIndex = 0; termIndex < termCount; termIndex++) modelValue += coefficients[termIndex]! * terms[termIndex]!;
      return cellLevel - modelValue;
    });
    const keptResiduals = residuals.filter((_residual, cellIndex) => isCellKept[cellIndex]);
    const { noise: residualSigma } = robustLevelAndNoise(keptResiduals);
    const rejectionLimit = options.rejectionKappa * Math.max(residualSigma, 0.05);
    let hasChanged = false;
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const shouldKeep = Math.abs(residuals[cellIndex]!) <= rejectionLimit;
      if (shouldKeep !== isCellKept[cellIndex]) hasChanged = true;
      isCellKept[cellIndex] = shouldKeep;
    }
    if (!hasChanged) break;
  }
  return {
    degree,
    coefficients,
    width,
    height,
    keptCellFraction: isCellKept.filter(Boolean).length / Math.max(1, cellCount),
  };
}

/** Resta el fondo ajustado; el cielo queda alrededor de 0. */
export function subtractSkyBackground(image: GrayImage, backgroundOptions: Partial<SkyBackgroundOptions> = {}): SkyBackgroundSubtraction {
  const model = fitSkyBackground(image, backgroundOptions);
  const { width, height, values } = image;
  const flattenedValues = new Float32Array(width * height);
  const terms = new Float64Array(model.coefficients.length);
  let lowestBackground = Infinity;
  let highestBackground = -Infinity;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const normalizedY = normalizedCoordinate(rowIndex, height);
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      polynomialTerms(normalizedCoordinate(columnIndex, width), normalizedY, model.degree, terms);
      let backgroundValue = 0;
      for (let termIndex = 0; termIndex < terms.length; termIndex++) backgroundValue += model.coefficients[termIndex]! * terms[termIndex]!;
      if (backgroundValue < lowestBackground) lowestBackground = backgroundValue;
      if (backgroundValue > highestBackground) highestBackground = backgroundValue;
      const pixelIndex = rowIndex * width + columnIndex;
      flattenedValues[pixelIndex] = values[pixelIndex]! - backgroundValue;
    }
  }
  const flattenedImage = { width, height, values: flattenedValues };
  const noiseMesh = estimateBackgroundMesh(flattenedImage, backgroundOptions.cellSize ?? defaultSkyBackgroundOptions.cellSize);
  return {
    flattenedImage,
    model,
    gradientRangeLevels: highestBackground - lowestBackground,
    backgroundNoise: robustLevelAndNoise(Array.from(noiseMesh.noises)).level,
  };
}

export interface AsinhStretchParameters {
  /** Valor que queda negro. */
  blackPoint: number;
  /** Valor que queda blanco. */
  whitePoint: number;
  /** β: cuanto mayor, más se levantan las zonas débiles (1 ≈ lineal). */
  stretchStrength: number;
}

/**
 * Parámetros automáticos para una imagen con el fondo restado: el negro un poco por debajo del
 * cielo (se ve el grano, no un negro recortado), el blanco en las estrellas más brillantes.
 */
export function automaticAsinhStretch(flattenedImage: GrayImage, backgroundNoise: number): AsinhStretchParameters {
  const { values } = flattenedImage;
  const sampleStride = Math.max(1, Math.floor(values.length / 40_000));
  const sampledValues: number[] = [];
  for (let valueIndex = 0; valueIndex < values.length; valueIndex += sampleStride) sampledValues.push(values[valueIndex]!);
  sampledValues.sort((first, second) => first - second);
  const noise = Math.max(backgroundNoise, 0.1);
  const brightestValue = sampledValues[Math.min(sampledValues.length - 1, Math.floor(sampledValues.length * 0.9995))] ?? noise * 50;
  const blackPoint = -2 * noise;
  const whitePoint = Math.max(blackPoint + 30 * noise, brightestValue);
  // El cielo (a 2σ del negro) queda en un gris oscuro de ~20/255.
  const skyFraction = (2 * noise) / (whitePoint - blackPoint);
  let stretchStrength = 1;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (Math.asinh(stretchStrength * skyFraction) / Math.asinh(stretchStrength) >= 0.08) break;
    stretchStrength *= 1.25;
  }
  return { blackPoint, whitePoint, stretchStrength };
}

/** Estira a bytes (0-255) con asinh. */
export function asinhStretchToBytes(image: GrayImage, parameters: AsinhStretchParameters): Uint8Array {
  const { values } = image;
  const outputBytes = new Uint8Array(values.length);
  const range = Math.max(1e-6, parameters.whitePoint - parameters.blackPoint);
  const strength = Math.max(1e-3, parameters.stretchStrength);
  const normalization = 255 / Math.asinh(strength);
  for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
    const normalizedValue = (values[pixelIndex]! - parameters.blackPoint) / range;
    const clampedValue = normalizedValue < 0 ? 0 : normalizedValue > 1 ? 1 : normalizedValue;
    outputBytes[pixelIndex] = Math.round(Math.asinh(strength * clampedValue) * normalization);
  }
  return outputBytes;
}
