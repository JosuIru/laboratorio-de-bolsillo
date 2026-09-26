/**
 * Centro y radio del disco lunar en una imagen, con precisión subpíxel y sea cual sea la fase.
 *
 * En cuarto creciente la mitad del borde del disco es el terminador, que no está en el círculo
 * (es media elipse), y el lado oscuro ni siquiera tiene borde. Por eso no vale el centroide de
 * la zona brillante: se buscan puntos del limbo y se les ajusta un círculo.
 *
 *  1. Umbral global: cruces del umbral en filas y columnas, con la dirección del gradiente.
 *  2. Cada cruce se afina a lo largo del gradiente hasta el nivel medio entre el fondo y el
 *     brillo local (así el albedo de cada zona no sesga el radio).
 *  3. RANSAC: círculos por tres puntos al azar; gana el que tiene más puntos a menos de
 *     `inlierTolerancePixels` y con el gradiente apuntando hacia su centro (el brillo crece hacia
 *     dentro en el limbo; en el terminador de una luna creciente crece hacia fuera).
 *  4. Mínimos cuadrados geométricos (Gauss-Newton) sobre esos puntos.
 *
 * Módulo puro: sin React ni React Native.
 */

import { createSeededRandom, gaussianBlurGray, type GrayImage, percentileOfValues, sampleBilinear } from './grayImage';

export interface EdgePoint {
  positionX: number;
  positionY: number;
  /** Dirección unitaria de máximo aumento del brillo. */
  gradientDirectionX: number;
  gradientDirectionY: number;
  /** Diferencia entre el brillo de dentro y el de fuera del borde. */
  edgeContrast: number;
}

export interface Circle {
  centerX: number;
  centerY: number;
  radius: number;
}

export interface LunarDiskFit extends Circle {
  /** Puntos de borde encontrados (limbo y terminador). */
  edgePointCount: number;
  /** Puntos del limbo usados en el ajuste final. */
  inlierCount: number;
  /** Error cuadrático medio de esos puntos respecto al círculo, en píxeles. */
  rmsResidualPixels: number;
  /** Fracción de la circunferencia cubierta por el limbo encontrado (≈ 0,5 en cuarto, 1 en llena). */
  limbCoverageFraction: number;
}

export interface DiskFitOptions {
  minimumRadiusPixels: number;
  /** Por defecto, media diagonal de la imagen. */
  maximumRadiusPixels?: number;
  /** Umbral para los cruces, 0-1 entre el fondo y el brillo del disco. */
  thresholdFraction: number;
  /** Suavizado previo contra el ruido, en píxeles. */
  smoothingSigmaPixels: number;
  /** Mitad de la longitud del perfil con que se afina cada punto, en píxeles. */
  profileHalfLengthPixels: number;
  /** Contraste mínimo del borde, como fracción del rango fondo-disco (el terminador real es suave). */
  minimumEdgeContrastFraction: number;
  ransacIterations: number;
  inlierTolerancePixels: number;
  /** Coseno mínimo entre el gradiente y la dirección al centro para contar como limbo. */
  minimumInwardCosine: number;
  randomSeed: number;
}

export const defaultDiskFitOptions: DiskFitOptions = {
  minimumRadiusPixels: 5,
  thresholdFraction: 0.35,
  smoothingSigmaPixels: 0.8,
  profileHalfLengthPixels: 3,
  minimumEdgeContrastFraction: 0.25,
  ransacIterations: 300,
  inlierTolerancePixels: 0.75,
  minimumInwardCosine: 0.8,
  randomSeed: 1969,
};

/** Caída máxima del perfil hacia dentro (fracción del contraste) para aceptar un punto. */
const maximumProfileDropFraction = 0.1;

/** Afina un cruce a lo largo del gradiente: nivel medio entre los extremos del perfil. */
function refineEdgeAlongGradient(
  image: GrayImage,
  startX: number,
  startY: number,
  directionX: number,
  directionY: number,
  profileHalfLength: number,
): { positionX: number; positionY: number; edgeContrast: number } | null {
  const stepLength = 0.25;
  const stepCount = Math.round(profileHalfLength / stepLength);
  // El perfil sigue hacia dentro la mitad más, solo para comprobar que no vuelve a bajar.
  const checkStepCount = Math.round(stepCount / 2);
  const profile = new Float32Array(3 * stepCount + 1 - (stepCount - checkStepCount));
  for (let sampleIndex = 0; sampleIndex < profile.length; sampleIndex++) {
    const stepOffset = (sampleIndex - stepCount) * stepLength;
    profile[sampleIndex] = sampleBilinear(image, startX + stepOffset * directionX, startY + stepOffset * directionY);
  }
  // Niveles de fuera y de dentro: la media del último píxel de cada extremo del perfil.
  const endSampleCount = Math.max(1, Math.round(1 / stepLength));
  let outsideSum = 0;
  let insideSum = 0;
  for (let sampleIndex = 0; sampleIndex < endSampleCount; sampleIndex++) {
    outsideSum += profile[sampleIndex]!;
    insideSum += profile[2 * stepCount - sampleIndex]!;
  }
  const outsideLevel = outsideSum / endSampleCount;
  const insideLevel = insideSum / endSampleCount;
  const edgeContrast = insideLevel - outsideLevel;
  if (edgeContrast <= 0) return null;
  // Perfil que sube y vuelve a bajar: un cuerno de la luna creciente o una mancha oscura justo
  // dentro del borde. El nivel medio no sería el del limbo, así que se descarta el punto.
  let innerMaximum = insideLevel;
  let innerMinimumAfterEdge = insideLevel;
  for (let sampleIndex = stepCount; sampleIndex < profile.length; sampleIndex++) {
    innerMaximum = Math.max(innerMaximum, profile[sampleIndex]!);
    if (sampleIndex >= 2 * stepCount) innerMinimumAfterEdge = Math.min(innerMinimumAfterEdge, profile[sampleIndex]!);
  }
  const allowedDrop = maximumProfileDropFraction * (innerMaximum - outsideLevel);
  if (innerMaximum - insideLevel > allowedDrop || insideLevel - innerMinimumAfterEdge > allowedDrop) return null;
  const middleLevel = (insideLevel + outsideLevel) / 2;
  let bestOffset = Number.POSITIVE_INFINITY;
  for (let sampleIndex = 0; sampleIndex < 2 * stepCount; sampleIndex++) {
    const currentValue = profile[sampleIndex]! - middleLevel;
    const nextValue = profile[sampleIndex + 1]! - middleLevel;
    if (currentValue <= 0 && nextValue > 0) {
      const crossingOffset = (sampleIndex - stepCount + currentValue / (currentValue - nextValue)) * stepLength;
      if (Math.abs(crossingOffset) < Math.abs(bestOffset)) bestOffset = crossingOffset;
    }
  }
  if (!Number.isFinite(bestOffset)) return null;
  return { positionX: startX + bestOffset * directionX, positionY: startY + bestOffset * directionY, edgeContrast };
}

/** Ruido por píxel, de la mediana de las diferencias entre vecinos horizontales (robusta a los bordes). */
export function estimateNoiseSigma(image: GrayImage): number {
  const { width, height, values } = image;
  const absoluteDifferences = new Float32Array((width - 1) * height);
  let differenceIndex = 0;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width - 1; columnIndex++) {
      const pixelIndex = rowIndex * width + columnIndex;
      absoluteDifferences[differenceIndex++] = Math.abs(values[pixelIndex + 1]! - values[pixelIndex]!);
    }
  }
  // Mediana de |diferencia| = 0,6745·√2·σ para ruido gaussiano.
  return percentileOfValues(absoluteDifferences, 50) / (0.6745 * Math.SQRT2);
}

/** El disco debe destacar sobre el fondo al menos este número de veces el ruido. */
const minimumRangeToNoiseRatio = 12;
/** Tolerancia más estrecha a la que se llega al refinar, en píxeles. */
const minimumInlierTolerancePixels = 0.2;
/** Fracción mínima de la circunferencia con limbo para dar el ajuste por bueno. */
const minimumLimbCoverage = 0.12;

/**
 * Puntos de borde del objeto brillante: cruces del umbral en filas (bordes más verticales que
 * horizontales) y columnas (el resto), afinados a lo largo del gradiente.
 */
export function extractEdgePoints(image: GrayImage, options: DiskFitOptions = defaultDiskFitOptions): EdgePoint[] {
  const smoothedImage = gaussianBlurGray(image, options.smoothingSigmaPixels);
  const { width, height, values } = smoothedImage;
  const backgroundLevel = percentileOfValues(values, 5);
  const brightLevel = percentileOfValues(values, 99.5);
  const brightnessRange = brightLevel - backgroundLevel;
  // Sin un objeto claramente por encima del ruido no hay bordes que buscar.
  if (brightnessRange <= minimumRangeToNoiseRatio * estimateNoiseSigma(image)) return [];
  const threshold = backgroundLevel + options.thresholdFraction * brightnessRange;
  const minimumContrast = options.minimumEdgeContrastFraction * brightnessRange;
  const valueAt = (columnIndex: number, rowIndex: number) =>
    values[Math.min(height - 1, Math.max(0, rowIndex)) * width + Math.min(width - 1, Math.max(0, columnIndex))]!;

  const edgePoints: EdgePoint[] = [];
  const addRefinedPoint = (crossingX: number, crossingY: number, gradientX: number, gradientY: number) => {
    const gradientMagnitude = Math.hypot(gradientX, gradientY);
    if (gradientMagnitude === 0) return;
    const directionX = gradientX / gradientMagnitude;
    const directionY = gradientY / gradientMagnitude;
    const refinedPoint = refineEdgeAlongGradient(
      smoothedImage,
      crossingX,
      crossingY,
      directionX,
      directionY,
      options.profileHalfLengthPixels,
    );
    if (!refinedPoint || refinedPoint.edgeContrast < minimumContrast) return;
    edgePoints.push({ ...refinedPoint, gradientDirectionX: directionX, gradientDirectionY: directionY });
  };

  for (let rowIndex = 1; rowIndex < height - 1; rowIndex++) {
    for (let columnIndex = 1; columnIndex < width - 2; columnIndex++) {
      const currentValue = valueAt(columnIndex, rowIndex) - threshold;
      const nextValue = valueAt(columnIndex + 1, rowIndex) - threshold;
      if (currentValue < 0 === nextValue < 0) continue;
      const gradientX = nextValue - currentValue;
      const gradientY =
        (valueAt(columnIndex, rowIndex + 1) - valueAt(columnIndex, rowIndex - 1) +
          valueAt(columnIndex + 1, rowIndex + 1) - valueAt(columnIndex + 1, rowIndex - 1)) / 4;
      if (Math.abs(gradientX) < Math.abs(gradientY)) continue;
      addRefinedPoint(columnIndex + currentValue / (currentValue - nextValue), rowIndex, gradientX, gradientY);
    }
  }
  for (let columnIndex = 1; columnIndex < width - 1; columnIndex++) {
    for (let rowIndex = 1; rowIndex < height - 2; rowIndex++) {
      const currentValue = valueAt(columnIndex, rowIndex) - threshold;
      const nextValue = valueAt(columnIndex, rowIndex + 1) - threshold;
      if (currentValue < 0 === nextValue < 0) continue;
      const gradientY = nextValue - currentValue;
      const gradientX =
        (valueAt(columnIndex + 1, rowIndex) - valueAt(columnIndex - 1, rowIndex) +
          valueAt(columnIndex + 1, rowIndex + 1) - valueAt(columnIndex - 1, rowIndex + 1)) / 4;
      if (Math.abs(gradientY) <= Math.abs(gradientX)) continue;
      addRefinedPoint(columnIndex, rowIndex + currentValue / (currentValue - nextValue), gradientX, gradientY);
    }
  }
  return edgePoints;
}

/** Círculo por tres puntos, o `null` si están alineados. */
function circleThroughThreePoints(first: EdgePoint, second: EdgePoint, third: EdgePoint): Circle | null {
  const secondDeltaX = second.positionX - first.positionX;
  const secondDeltaY = second.positionY - first.positionY;
  const thirdDeltaX = third.positionX - first.positionX;
  const thirdDeltaY = third.positionY - first.positionY;
  const determinant = 2 * (secondDeltaX * thirdDeltaY - secondDeltaY * thirdDeltaX);
  if (Math.abs(determinant) < 1e-9) return null;
  const secondSquaredNorm = secondDeltaX * secondDeltaX + secondDeltaY * secondDeltaY;
  const thirdSquaredNorm = thirdDeltaX * thirdDeltaX + thirdDeltaY * thirdDeltaY;
  const centerOffsetX = (thirdDeltaY * secondSquaredNorm - secondDeltaY * thirdSquaredNorm) / determinant;
  const centerOffsetY = (secondDeltaX * thirdSquaredNorm - thirdDeltaX * secondSquaredNorm) / determinant;
  return {
    centerX: first.positionX + centerOffsetX,
    centerY: first.positionY + centerOffsetY,
    radius: Math.hypot(centerOffsetX, centerOffsetY),
  };
}

/**
 * Ajuste algebraico de Kåsa: minimiza Σ (x² + y² + D·x + E·y + F)². Rápido y sin iterar;
 * sirve de punto de partida para el geométrico.
 */
export function fitCircleAlgebraic(points: readonly EdgePoint[]): Circle | null {
  if (points.length < 3) return null;
  let meanX = 0;
  let meanY = 0;
  for (const point of points) {
    meanX += point.positionX;
    meanY += point.positionY;
  }
  meanX /= points.length;
  meanY /= points.length;
  // Coordenadas centradas para que el sistema esté bien condicionado.
  let sumUU = 0;
  let sumUV = 0;
  let sumVV = 0;
  let sumUR = 0;
  let sumVR = 0;
  for (const point of points) {
    const centeredX = point.positionX - meanX;
    const centeredY = point.positionY - meanY;
    const squaredRadius = centeredX * centeredX + centeredY * centeredY;
    sumUU += centeredX * centeredX;
    sumUV += centeredX * centeredY;
    sumVV += centeredY * centeredY;
    sumUR += centeredX * squaredRadius;
    sumVR += centeredY * squaredRadius;
  }
  const determinant = sumUU * sumVV - sumUV * sumUV;
  if (Math.abs(determinant) < 1e-12) return null;
  const centerOffsetX = (sumVV * sumUR - sumUV * sumVR) / (2 * determinant);
  const centerOffsetY = (sumUU * sumVR - sumUV * sumUR) / (2 * determinant);
  const radius = Math.sqrt(centerOffsetX ** 2 + centerOffsetY ** 2 + (sumUU + sumVV) / points.length);
  return { centerX: meanX + centerOffsetX, centerY: meanY + centerOffsetY, radius };
}

/** Mínimos cuadrados geométricos (distancia real al círculo) por Gauss-Newton. */
export function refineCircleGeometric(points: readonly EdgePoint[], initialCircle: Circle, iterationCount = 10): Circle {
  let { centerX, centerY, radius } = initialCircle;
  for (let iterationIndex = 0; iterationIndex < iterationCount; iterationIndex++) {
    // Ecuaciones normales 3×3 de residuo = distancia − radio.
    const normalMatrix = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const rightHandSide = [0, 0, 0];
    for (const point of points) {
      const deltaX = point.positionX - centerX;
      const deltaY = point.positionY - centerY;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance === 0) continue;
      const jacobian = [-deltaX / distance, -deltaY / distance, -1];
      const residual = distance - radius;
      for (let rowIndex = 0; rowIndex < 3; rowIndex++) {
        rightHandSide[rowIndex]! -= jacobian[rowIndex]! * residual;
        for (let columnIndex = 0; columnIndex < 3; columnIndex++) {
          normalMatrix[rowIndex * 3 + columnIndex]! += jacobian[rowIndex]! * jacobian[columnIndex]!;
        }
      }
    }
    const step = solveThreeByThree(normalMatrix, rightHandSide);
    if (!step) break;
    centerX += step[0]!;
    centerY += step[1]!;
    radius += step[2]!;
    if (Math.abs(step[0]!) + Math.abs(step[1]!) + Math.abs(step[2]!) < 1e-6) break;
  }
  return { centerX, centerY, radius };
}

function solveThreeByThree(matrix: number[], rightHandSide: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = matrix as [number, number, number, number, number, number, number, number, number];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-12) return null;
  const [r0, r1, r2] = rightHandSide as [number, number, number];
  return [
    (r0 * (e * i - f * h) - b * (r1 * i - f * r2) + c * (r1 * h - e * r2)) / determinant,
    (a * (r1 * i - f * r2) - r0 * (d * i - f * g) + c * (d * r2 - r1 * g)) / determinant,
    (a * (e * r2 - r1 * h) - b * (d * r2 - r1 * g) + r0 * (d * h - e * g)) / determinant,
  ];
}

/** Puntos a menos de `tolerance` del círculo y con el brillo creciendo hacia su centro. */
function selectLimbInliers(
  points: readonly EdgePoint[],
  circle: Circle,
  tolerance: number,
  minimumInwardCosine: number,
): EdgePoint[] {
  const inliers: EdgePoint[] = [];
  for (const point of points) {
    const towardCenterX = circle.centerX - point.positionX;
    const towardCenterY = circle.centerY - point.positionY;
    const distance = Math.hypot(towardCenterX, towardCenterY);
    if (Math.abs(distance - circle.radius) > tolerance || distance === 0) continue;
    const inwardCosine = (towardCenterX * point.gradientDirectionX + towardCenterY * point.gradientDirectionY) / distance;
    if (inwardCosine >= minimumInwardCosine) inliers.push(point);
  }
  return inliers;
}

/** Fracción de 72 sectores de 5° de la circunferencia con algún punto. */
function angularCoverage(points: readonly EdgePoint[], circle: Circle): number {
  const sectorCount = 72;
  const occupiedSectors = new Uint8Array(sectorCount);
  for (const point of points) {
    const angle = Math.atan2(point.positionY - circle.centerY, point.positionX - circle.centerX);
    const sectorIndex = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * sectorCount) % sectorCount;
    occupiedSectors[sectorIndex] = 1;
  }
  return occupiedSectors.reduce((occupiedCount, isOccupied) => occupiedCount + isOccupied, 0) / sectorCount;
}

/** Centro y radio del disco lunar, o `null` si no hay un limbo reconocible. */
export function fitLunarDisk(image: GrayImage, partialOptions: Partial<DiskFitOptions> = {}): LunarDiskFit | null {
  const options = { ...defaultDiskFitOptions, ...partialOptions };
  const maximumRadius = options.maximumRadiusPixels ?? Math.hypot(image.width, image.height) / 2;
  const edgePoints = extractEdgePoints(image, options);
  if (edgePoints.length < 8) return null;

  const random = createSeededRandom(options.randomSeed);
  let bestCircle: Circle | null = null;
  let bestInlierCount = 0;
  for (let iterationIndex = 0; iterationIndex < options.ransacIterations; iterationIndex++) {
    const first = edgePoints[Math.floor(random() * edgePoints.length)]!;
    const second = edgePoints[Math.floor(random() * edgePoints.length)]!;
    const third = edgePoints[Math.floor(random() * edgePoints.length)]!;
    const candidateCircle = circleThroughThreePoints(first, second, third);
    if (!candidateCircle) continue;
    if (candidateCircle.radius < options.minimumRadiusPixels || candidateCircle.radius > maximumRadius) continue;
    const inlierCount = selectLimbInliers(
      edgePoints,
      candidateCircle,
      options.inlierTolerancePixels,
      options.minimumInwardCosine,
    ).length;
    if (inlierCount > bestInlierCount) {
      bestInlierCount = inlierCount;
      bestCircle = candidateCircle;
    }
  }
  if (!bestCircle || bestInlierCount < 6) return null;

  // Refinado: mínimos cuadrados sobre los puntos del limbo, re-seleccionándolos con el círculo
  // mejorado y con una tolerancia que se estrecha hasta 3 desviaciones robustas: cerca de los
  // cuernos el terminador se acerca al limbo y colaría puntos que encogen el círculo.
  let fittedCircle = bestCircle;
  let inlierTolerance = options.inlierTolerancePixels;
  let inliers = selectLimbInliers(edgePoints, fittedCircle, inlierTolerance, options.minimumInwardCosine);
  for (let refinementIndex = 0; refinementIndex < 5; refinementIndex++) {
    const algebraicCircle = refinementIndex === 0 ? fitCircleAlgebraic(inliers) : null;
    fittedCircle = refineCircleGeometric(inliers, algebraicCircle ?? fittedCircle);
    const absoluteResiduals = new Float32Array(inliers.length);
    inliers.forEach((point, pointIndex) => {
      absoluteResiduals[pointIndex] = Math.abs(
        Math.hypot(point.positionX - fittedCircle.centerX, point.positionY - fittedCircle.centerY) - fittedCircle.radius,
      );
    });
    const robustSigma = 1.4826 * percentileOfValues(absoluteResiduals, 50);
    inlierTolerance = Math.min(options.inlierTolerancePixels, Math.max(minimumInlierTolerancePixels, 3 * robustSigma));
    inliers = selectLimbInliers(edgePoints, fittedCircle, inlierTolerance, options.minimumInwardCosine);
    if (inliers.length < 6) return null;
  }
  fittedCircle = refineCircleGeometric(inliers, fittedCircle);

  let squaredResidualSum = 0;
  for (const point of inliers) {
    const residual = Math.hypot(point.positionX - fittedCircle.centerX, point.positionY - fittedCircle.centerY) - fittedCircle.radius;
    squaredResidualSum += residual * residual;
  }
  const limbCoverageFraction = angularCoverage(inliers, fittedCircle);
  if (limbCoverageFraction < minimumLimbCoverage) return null;
  return {
    ...fittedCircle,
    edgePointCount: edgePoints.length,
    inlierCount: inliers.length,
    rmsResidualPixels: Math.sqrt(squaredResidualSum / inliers.length),
    limbCoverageFraction,
  };
}
