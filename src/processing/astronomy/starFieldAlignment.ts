/**
 * Alineado de campos de estrellas: rotación + traslación (transformación rígida) entre las
 * estrellas de un fotograma y las del de referencia.
 *
 * Con el móvil quieto, el cielo gira alrededor del polo celeste (~15″ por segundo de tiempo): en
 * la imagen, cada fotograma está girado un poco y desplazado respecto al anterior. Sin escala
 * (misma óptica) ni deformaciones apreciables en unos minutos.
 *
 *  1. Hipótesis por pares: la distancia entre dos estrellas no cambia con una transformación
 *     rígida. Para cada par de las más brillantes del fotograma se buscan pares de la referencia
 *     con la misma distancia (± tolerancia); cada coincidencia fija una rotación y una traslación.
 *     Es la idea del emparejado por triángulos, reducida a pares porque no hay escala que
 *     resolver.
 *  2. Se puntúa cada hipótesis por cuántas estrellas caen a menos de `matchTolerancePixels` de
 *     una de la referencia (consenso, como en RANSAC pero recorriendo los pares).
 *  3. Afinado por mínimos cuadrados (Procrustes 2D) con todas las parejas, dos o tres veces.
 *
 * Módulo puro: sin React ni React Native.
 */

export interface StarPosition {
  x: number;
  y: number;
}

/**
 * Transformación rígida: p' = R(θ)·p + t. Lleva puntos del fotograma que se alinea a la
 * referencia.
 */
export interface RigidTransform {
  rotationRadians: number;
  translationX: number;
  translationY: number;
}

export const identityRigidTransform: RigidTransform = { rotationRadians: 0, translationX: 0, translationY: 0 };

export interface StarFieldAlignment {
  transform: RigidTransform;
  /** Estrellas emparejadas en el afinado final. */
  matchedStarCount: number;
  /** Error cuadrático medio de las parejas tras el afinado, en píxeles. */
  rmsResidualPixels: number;
}

export interface StarFieldAlignmentOptions {
  /** Estrellas más brillantes de cada lista con que se generan hipótesis. */
  hypothesisStarCount: number;
  /** Estrellas que se usan en el afinado. */
  refinementStarCount: number;
  /** Distancia máxima para considerar dos estrellas la misma. */
  matchTolerancePixels: number;
  /** Pares más cortos no sirven para medir el ángulo con precisión. */
  minimumPairDistancePixels: number;
  /** Mayor giro que se acepta (el cielo gira 0,25° por minuto como mucho). */
  maximumRotationRadians: number;
  /** Mínimo de parejas para dar el alineado por bueno. */
  minimumMatchedStars: number;
}

export const defaultStarFieldAlignmentOptions: StarFieldAlignmentOptions = {
  hypothesisStarCount: 25,
  refinementStarCount: 300,
  matchTolerancePixels: 2,
  minimumPairDistancePixels: 20,
  maximumRotationRadians: (10 * Math.PI) / 180,
  minimumMatchedStars: 5,
};

export function applyRigidTransform(transform: RigidTransform, point: StarPosition): StarPosition {
  const cosine = Math.cos(transform.rotationRadians);
  const sine = Math.sin(transform.rotationRadians);
  return {
    x: cosine * point.x - sine * point.y + transform.translationX,
    y: sine * point.x + cosine * point.y + transform.translationY,
  };
}

export function invertRigidTransform(transform: RigidTransform): RigidTransform {
  const cosine = Math.cos(transform.rotationRadians);
  const sine = Math.sin(transform.rotationRadians);
  // p = R(−θ)·(p' − t)
  return {
    rotationRadians: -transform.rotationRadians,
    translationX: -(cosine * transform.translationX + sine * transform.translationY),
    translationY: -(-sine * transform.translationX + cosine * transform.translationY),
  };
}

/** Primero `first`, después `second`: p'' = second(first(p)). */
export function composeRigidTransforms(first: RigidTransform, second: RigidTransform): RigidTransform {
  const movedTranslation = applyRigidTransform(
    { rotationRadians: second.rotationRadians, translationX: 0, translationY: 0 },
    { x: first.translationX, y: first.translationY },
  );
  return {
    rotationRadians: first.rotationRadians + second.rotationRadians,
    translationX: movedTranslation.x + second.translationX,
    translationY: movedTranslation.y + second.translationY,
  };
}

/**
 * Fracción `fraction` (0-1) del movimiento: el mismo giro alrededor del mismo punto fijo (el polo,
 * si cae en la imagen o fuera de ella), pero solo `fraction` del ángulo. Sin giro, la traslación
 * proporcional. Sirve para rellenar los huecos entre fotogramas en los trazos.
 */
export function interpolateRigidTransform(transform: RigidTransform, fraction: number): RigidTransform {
  const { rotationRadians, translationX, translationY } = transform;
  if (Math.abs(rotationRadians) < 1e-9) {
    return { rotationRadians: 0, translationX: translationX * fraction, translationY: translationY * fraction };
  }
  // Punto fijo c: (I − R)·c = t.
  const cosine = Math.cos(rotationRadians);
  const sine = Math.sin(rotationRadians);
  const matrixA = 1 - cosine;
  const matrixB = sine;
  const determinant = matrixA * matrixA + matrixB * matrixB;
  const fixedPointX = (matrixA * translationX - matrixB * translationY) / determinant;
  const fixedPointY = (matrixB * translationX + matrixA * translationY) / determinant;
  const partialRotation = rotationRadians * fraction;
  const partialCosine = Math.cos(partialRotation);
  const partialSine = Math.sin(partialRotation);
  // p' = R_f·(p − c) + c
  return {
    rotationRadians: partialRotation,
    translationX: fixedPointX - (partialCosine * fixedPointX - partialSine * fixedPointY),
    translationY: fixedPointY - (partialSine * fixedPointX + partialCosine * fixedPointY),
  };
}

/** Mayor desplazamiento que produce la transformación en las esquinas de una imagen. */
export function maximumDisplacementInImage(transform: RigidTransform, width: number, height: number): number {
  let largestDisplacement = 0;
  for (const corner of [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ]) {
    const movedCorner = applyRigidTransform(transform, corner);
    largestDisplacement = Math.max(largestDisplacement, Math.hypot(movedCorner.x - corner.x, movedCorner.y - corner.y));
  }
  return largestDisplacement;
}

interface StarPair {
  firstIndex: number;
  secondIndex: number;
  distance: number;
  angle: number;
}

function buildPairs(stars: readonly StarPosition[], minimumDistance: number): StarPair[] {
  const pairs: StarPair[] = [];
  for (let firstIndex = 0; firstIndex < stars.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < stars.length; secondIndex++) {
      const deltaX = stars[secondIndex]!.x - stars[firstIndex]!.x;
      const deltaY = stars[secondIndex]!.y - stars[firstIndex]!.y;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance >= minimumDistance) pairs.push({ firstIndex, secondIndex, distance, angle: Math.atan2(deltaY, deltaX) });
    }
  }
  return pairs.sort((first, second) => first.distance - second.distance);
}

function normalizeAngle(angleRadians: number): number {
  let normalizedAngle = angleRadians;
  while (normalizedAngle > Math.PI) normalizedAngle -= 2 * Math.PI;
  while (normalizedAngle <= -Math.PI) normalizedAngle += 2 * Math.PI;
  return normalizedAngle;
}

/** Índice de la estrella de referencia más cercana a un punto, con una rejilla de celdas. */
class StarGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly columnCount = 100_000;

  constructor(
    private readonly stars: readonly StarPosition[],
    private readonly cellSize: number,
  ) {
    stars.forEach((star, starIndex) => {
      const cellKey = this.cellKey(Math.floor(star.x / cellSize), Math.floor(star.y / cellSize));
      const cellStars = this.cells.get(cellKey);
      if (cellStars) cellStars.push(starIndex);
      else this.cells.set(cellKey, [starIndex]);
    });
  }

  private cellKey(cellColumn: number, cellRow: number): number {
    return (cellRow + 50_000) * this.columnCount + cellColumn + 50_000;
  }

  /** La más cercana a menos de `maximumDistance` (≤ tamaño de celda), o −1. */
  nearest(point: StarPosition, maximumDistance: number): { starIndex: number; distanceSquared: number } {
    const cellColumn = Math.floor(point.x / this.cellSize);
    const cellRow = Math.floor(point.y / this.cellSize);
    let bestIndex = -1;
    let bestDistanceSquared = maximumDistance * maximumDistance;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        const cellStars = this.cells.get(this.cellKey(cellColumn + columnOffset, cellRow + rowOffset));
        if (!cellStars) continue;
        for (const starIndex of cellStars) {
          const star = this.stars[starIndex]!;
          const distanceSquared = (star.x - point.x) ** 2 + (star.y - point.y) ** 2;
          if (distanceSquared <= bestDistanceSquared) {
            bestDistanceSquared = distanceSquared;
            bestIndex = starIndex;
          }
        }
      }
    }
    return { starIndex: bestIndex, distanceSquared: bestDistanceSquared };
  }
}

function countInliers(
  transform: RigidTransform,
  movingStars: readonly StarPosition[],
  referenceGrid: StarGrid,
  tolerance: number,
): number {
  let inlierCount = 0;
  for (const movingStar of movingStars) {
    if (referenceGrid.nearest(applyRigidTransform(transform, movingStar), tolerance).starIndex >= 0) inlierCount++;
  }
  return inlierCount;
}

/** Transformación rígida de mínimos cuadrados entre parejas (Procrustes 2D, sin escala). */
export function fitRigidTransform(
  movingPoints: readonly StarPosition[],
  referencePoints: readonly StarPosition[],
): RigidTransform {
  const pointCount = movingPoints.length;
  if (pointCount === 0) return identityRigidTransform;
  let movingMeanX = 0;
  let movingMeanY = 0;
  let referenceMeanX = 0;
  let referenceMeanY = 0;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    movingMeanX += movingPoints[pointIndex]!.x;
    movingMeanY += movingPoints[pointIndex]!.y;
    referenceMeanX += referencePoints[pointIndex]!.x;
    referenceMeanY += referencePoints[pointIndex]!.y;
  }
  movingMeanX /= pointCount;
  movingMeanY /= pointCount;
  referenceMeanX /= pointCount;
  referenceMeanY /= pointCount;
  let dotSum = 0;
  let crossSum = 0;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const movingX = movingPoints[pointIndex]!.x - movingMeanX;
    const movingY = movingPoints[pointIndex]!.y - movingMeanY;
    const referenceX = referencePoints[pointIndex]!.x - referenceMeanX;
    const referenceY = referencePoints[pointIndex]!.y - referenceMeanY;
    dotSum += movingX * referenceX + movingY * referenceY;
    crossSum += movingX * referenceY - movingY * referenceX;
  }
  const rotationRadians = pointCount >= 2 ? Math.atan2(crossSum, dotSum) : 0;
  const cosine = Math.cos(rotationRadians);
  const sine = Math.sin(rotationRadians);
  return {
    rotationRadians,
    translationX: referenceMeanX - (cosine * movingMeanX - sine * movingMeanY),
    translationY: referenceMeanY - (sine * movingMeanX + cosine * movingMeanY),
  };
}

function refineAlignment(
  initialTransform: RigidTransform,
  movingStars: readonly StarPosition[],
  referenceStars: readonly StarPosition[],
  referenceGrid: StarGrid,
  tolerance: number,
): StarFieldAlignment {
  let transform = initialTransform;
  let matchedStarCount = 0;
  let rmsResidualPixels = 0;
  for (let refinementRound = 0; refinementRound < 3; refinementRound++) {
    const matchedMovingPoints: StarPosition[] = [];
    const matchedReferencePoints: StarPosition[] = [];
    const usedReferenceIndices = new Set<number>();
    for (const movingStar of movingStars) {
      const nearestMatch = referenceGrid.nearest(applyRigidTransform(transform, movingStar), tolerance);
      if (nearestMatch.starIndex < 0 || usedReferenceIndices.has(nearestMatch.starIndex)) continue;
      usedReferenceIndices.add(nearestMatch.starIndex);
      matchedMovingPoints.push(movingStar);
      matchedReferencePoints.push(referenceStars[nearestMatch.starIndex]!);
    }
    if (matchedMovingPoints.length < 2) break;
    transform = fitRigidTransform(matchedMovingPoints, matchedReferencePoints);
    matchedStarCount = matchedMovingPoints.length;
    let squaredResidualSum = 0;
    for (let pointIndex = 0; pointIndex < matchedMovingPoints.length; pointIndex++) {
      const movedPoint = applyRigidTransform(transform, matchedMovingPoints[pointIndex]!);
      squaredResidualSum +=
        (movedPoint.x - matchedReferencePoints[pointIndex]!.x) ** 2 + (movedPoint.y - matchedReferencePoints[pointIndex]!.y) ** 2;
    }
    rmsResidualPixels = Math.sqrt(squaredResidualSum / matchedMovingPoints.length);
  }
  return { transform, matchedStarCount, rmsResidualPixels };
}

/**
 * Transformación que lleva `movingStars` sobre `referenceStars` (listas de más a menos
 * brillante). null si no hay suficientes parejas.
 */
export function alignStarFields(
  referenceStars: readonly StarPosition[],
  movingStars: readonly StarPosition[],
  alignmentOptions: Partial<StarFieldAlignmentOptions> = {},
): StarFieldAlignment | null {
  const options = { ...defaultStarFieldAlignmentOptions, ...alignmentOptions };
  const tolerance = options.matchTolerancePixels;
  const referenceHypothesisStars = referenceStars.slice(0, options.hypothesisStarCount);
  const movingHypothesisStars = movingStars.slice(0, options.hypothesisStarCount);
  const minimumMatches = Math.min(options.minimumMatchedStars, referenceHypothesisStars.length, movingHypothesisStars.length);
  if (minimumMatches < 2) return null;

  const referenceGridForHypotheses = new StarGrid(referenceHypothesisStars, Math.max(tolerance, 1));
  const referencePairs = buildPairs(referenceHypothesisStars, options.minimumPairDistancePixels);
  const movingPairs = buildPairs(movingHypothesisStars, options.minimumPairDistancePixels);
  const referenceDistances = Float64Array.from(referencePairs, (pair) => pair.distance);
  // Suficiente: casi todas las estrellas comunes a los dos campos ya encajan.
  const goodEnoughInlierCount = Math.ceil(0.8 * Math.min(referenceHypothesisStars.length, movingHypothesisStars.length));

  let bestTransform: RigidTransform | null = null;
  let bestInlierCount = 0;
  for (const movingPair of movingPairs) {
    // Pares de la referencia con distancia en [d − tolerancia·2, d + tolerancia·2].
    const lowestDistance = movingPair.distance - 2 * tolerance;
    let lowIndex = 0;
    let highIndex = referenceDistances.length;
    while (lowIndex < highIndex) {
      const middleIndex = (lowIndex + highIndex) >> 1;
      if (referenceDistances[middleIndex]! < lowestDistance) lowIndex = middleIndex + 1;
      else highIndex = middleIndex;
    }
    for (let referencePairIndex = lowIndex; referencePairIndex < referencePairs.length; referencePairIndex++) {
      const referencePair = referencePairs[referencePairIndex]!;
      if (referencePair.distance > movingPair.distance + 2 * tolerance) break;
      // Las dos correspondencias posibles: (a→a', b→b') o (a→b', b→a').
      for (const isSwapped of [false, true]) {
        const referenceAngle = isSwapped ? normalizeAngle(referencePair.angle + Math.PI) : referencePair.angle;
        const rotationRadians = normalizeAngle(referenceAngle - movingPair.angle);
        if (Math.abs(rotationRadians) > options.maximumRotationRadians) continue;
        const movingAnchor = movingHypothesisStars[movingPair.firstIndex]!;
        const referenceAnchor = referenceHypothesisStars[isSwapped ? referencePair.secondIndex : referencePair.firstIndex]!;
        const cosine = Math.cos(rotationRadians);
        const sine = Math.sin(rotationRadians);
        const hypothesis: RigidTransform = {
          rotationRadians,
          translationX: referenceAnchor.x - (cosine * movingAnchor.x - sine * movingAnchor.y),
          translationY: referenceAnchor.y - (sine * movingAnchor.x + cosine * movingAnchor.y),
        };
        const inlierCount = countInliers(hypothesis, movingHypothesisStars, referenceGridForHypotheses, tolerance);
        if (inlierCount > bestInlierCount) {
          bestInlierCount = inlierCount;
          bestTransform = hypothesis;
        }
      }
      if (bestInlierCount >= goodEnoughInlierCount) break;
    }
    if (bestInlierCount >= goodEnoughInlierCount) break;
  }
  if (!bestTransform || bestInlierCount < minimumMatches) return null;

  const referenceRefinementStars = referenceStars.slice(0, options.refinementStarCount);
  const movingRefinementStars = movingStars.slice(0, options.refinementStarCount);
  const refinedAlignment = refineAlignment(
    bestTransform,
    movingRefinementStars,
    referenceRefinementStars,
    new StarGrid(referenceRefinementStars, Math.max(tolerance, 1)),
    tolerance,
  );
  if (refinedAlignment.matchedStarCount < minimumMatches) return null;
  return refinedAlignment;
}
