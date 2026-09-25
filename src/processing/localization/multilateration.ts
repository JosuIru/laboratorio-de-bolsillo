/**
 * Posición de una fuente de sonido a partir de las diferencias de tiempo de llegada (TDOA).
 *
 * Cada micrófono `i` (en `p_i`) aporta un «pseudorrango» `r_i = |x − p_i| + b`: la distancia a la
 * fuente más un sesgo `b` común a todos, desconocido (el instante en que sonó la palmada respecto
 * al chirrido de referencia, pasado a metros). Es la misma formulación que usa el GPS. Restar
 * pseudorrangos elimina `b` y deja las hipérbolas de la multilateración: |x − p_j| − |x − p_i| =
 * r_j − r_i. Aquí se resuelven las tres incógnitas (x, y, b) a la vez por mínimos cuadrados con
 * Gauss-Newton amortiguado (Levenberg-Marquardt), que equivale a ajustar todas las hipérbolas.
 *
 * Con tres micrófonos hay tantas ecuaciones como incógnitas: las hipérbolas se cortan en uno o en
 * dos puntos. Por eso se arranca desde varios mínimos de una rejilla y, si dos soluciones explican
 * igual de bien las medidas, se devuelve también la otra: la ambigüedad es real y hay que decirla.
 */

export interface PlanePoint {
  x: number;
  y: number;
}

export interface ErrorEllipse {
  center: PlanePoint;
  semiMajorAxisMeters: number;
  semiMinorAxisMeters: number;
  /** Ángulo del semieje mayor respecto al eje x, en radianes. */
  orientationRadians: number;
  /** Probabilidad de que la fuente esté dentro (con el modelo de errores supuesto). */
  confidenceLevel: number;
}

export interface TdoaSolution {
  position: PlanePoint;
  rangeBiasMeters: number;
  /** Residuo de cada micrófono (m): lo que el ajuste no explica. */
  residualsMeters: number[];
  rootMeanSquareResidualMeters: number;
  /** Desviación típica de cada pseudorrango usada para la covarianza (m). */
  rangeStandardDeviationMeters: number;
  /** Covarianza de (x, y) en m², o `null` si la geometría es degenerada. */
  positionCovariance: { xx: number; xy: number; yy: number } | null;
  errorEllipse: ErrorEllipse | null;
  /** Otra posición compatible con las medidas (típico con tres micrófonos), o `null`. */
  alternativePosition: PlanePoint | null;
  iterationCount: number;
}

export interface TdoaSolverOptions {
  receiverPositions: readonly PlanePoint[];
  pseudorangesMeters: readonly number[];
  /** Incertidumbre supuesta de cada pseudorrango (m): tiempos y posiciones de los micrófonos. */
  rangeStandardDeviationMeters: number;
  /** Zona donde se busca el punto de partida. Por defecto, los micrófonos con un margen amplio. */
  searchBounds?: { minimumX: number; maximumX: number; minimumY: number; maximumY: number };
}

/** χ² con 2 grados de libertad al 95 %: escala de la elipse de confianza. */
const chiSquare95TwoDegrees = 5.991;
const gridResolution = 81;
const maximumStartingPoints = 5;
const maximumIterations = 100;
const duplicateSolutionDistanceMeters = 0.2;

export function distanceBetween(firstPoint: PlanePoint, secondPoint: PlanePoint): number {
  return Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y);
}

/**
 * Pseudorrangos a partir de los intervalos «chirrido → palmada» medidos en cada micrófono:
 * r_i = c·Δ_i + |p_i − emisor|. El segundo término devuelve cada intervalo al instante en que
 * *salió* el chirrido (común a todos), quitando lo que tardó en llegar a ese micrófono.
 */
export function pseudorangesFromIntervals(
  intervalsSeconds: readonly number[],
  receiverPositions: readonly PlanePoint[],
  emitterPosition: PlanePoint,
  speedOfSoundMetersPerSecond: number,
): number[] {
  if (intervalsSeconds.length !== receiverPositions.length) {
    throw new RangeError('Hace falta un intervalo por micrófono');
  }
  return intervalsSeconds.map(
    (intervalSeconds, receiverIndex) =>
      speedOfSoundMetersPerSecond * intervalSeconds + distanceBetween(receiverPositions[receiverIndex]!, emitterPosition),
  );
}

/** Intervalos que mediría cada micrófono si la fuente estuviera en `sourcePosition` (para tests y simulaciones). */
export function simulateIntervals(
  sourcePosition: PlanePoint,
  receiverPositions: readonly PlanePoint[],
  emitterPosition: PlanePoint,
  speedOfSoundMetersPerSecond: number,
  clapDelayAfterChirpSeconds: number,
): number[] {
  return receiverPositions.map(
    (receiverPosition) =>
      clapDelayAfterChirpSeconds +
      (distanceBetween(sourcePosition, receiverPosition) - distanceBetween(emitterPosition, receiverPosition)) /
        speedOfSoundMetersPerSecond,
  );
}

function defaultSearchBounds(receiverPositions: readonly PlanePoint[]) {
  const xValues = receiverPositions.map((receiverPosition) => receiverPosition.x);
  const yValues = receiverPositions.map((receiverPosition) => receiverPosition.y);
  const minimumX = Math.min(...xValues);
  const maximumX = Math.max(...xValues);
  const minimumY = Math.min(...yValues);
  const maximumY = Math.max(...yValues);
  const margin = Math.max(5, 2 * Math.hypot(maximumX - minimumX, maximumY - minimumY));
  return { minimumX: minimumX - margin, maximumX: maximumX + margin, minimumY: minimumY - margin, maximumY: maximumY + margin };
}

/** Coste con el sesgo eliminado analíticamente (su óptimo es la media de r_i − d_i). */
function costWithOptimalBias(position: PlanePoint, receiverPositions: readonly PlanePoint[], pseudoranges: readonly number[]) {
  const distances = receiverPositions.map((receiverPosition) => distanceBetween(position, receiverPosition));
  let biasSum = 0;
  for (let receiverIndex = 0; receiverIndex < distances.length; receiverIndex++) {
    biasSum += pseudoranges[receiverIndex]! - distances[receiverIndex]!;
  }
  const optimalBias = biasSum / distances.length;
  let squaredResidualSum = 0;
  for (let receiverIndex = 0; receiverIndex < distances.length; receiverIndex++) {
    squaredResidualSum += (distances[receiverIndex]! + optimalBias - pseudoranges[receiverIndex]!) ** 2;
  }
  return { cost: squaredResidualSum, optimalBias };
}

/** Resuelve A·x = b (3×3) por Cramer; `null` si es singular. */
function solveThreeByThree(matrix: number[][], rightHandSide: number[]): number[] | null {
  const determinantOf = (columns: number[][]) =>
    columns[0]![0]! * (columns[1]![1]! * columns[2]![2]! - columns[1]![2]! * columns[2]![1]!) -
    columns[0]![1]! * (columns[1]![0]! * columns[2]![2]! - columns[1]![2]! * columns[2]![0]!) +
    columns[0]![2]! * (columns[1]![0]! * columns[2]![1]! - columns[1]![1]! * columns[2]![0]!);
  const determinant = determinantOf(matrix);
  const scale = Math.max(...matrix.flat().map(Math.abs), 1e-300);
  if (!(Math.abs(determinant) > 1e-12 * scale ** 3)) return null;
  return [0, 1, 2].map((replacedColumn) => {
    const replacedMatrix = matrix.map((row, rowIndex) =>
      row.map((entry, columnIndex) => (columnIndex === replacedColumn ? rightHandSide[rowIndex]! : entry)),
    );
    return determinantOf(replacedMatrix) / determinant;
  });
}

function invertThreeByThree(matrix: number[][]): number[][] | null {
  const columns = [
    solveThreeByThree(matrix, [1, 0, 0]),
    solveThreeByThree(matrix, [0, 1, 0]),
    solveThreeByThree(matrix, [0, 0, 1]),
  ];
  if (columns.some((column) => column === null)) return null;
  return [0, 1, 2].map((rowIndex) => [0, 1, 2].map((columnIndex) => columns[columnIndex]![rowIndex]!));
}

interface LinearizedProblem {
  residuals: number[];
  jacobianRows: number[][];
  cost: number;
}

function linearize(parameters: number[], receiverPositions: readonly PlanePoint[], pseudoranges: readonly number[]): LinearizedProblem {
  const [positionX, positionY, rangeBias] = parameters as [number, number, number];
  const residuals: number[] = [];
  const jacobianRows: number[][] = [];
  let cost = 0;
  for (let receiverIndex = 0; receiverIndex < receiverPositions.length; receiverIndex++) {
    const receiverPosition = receiverPositions[receiverIndex]!;
    const deltaX = positionX - receiverPosition.x;
    const deltaY = positionY - receiverPosition.y;
    const distance = Math.hypot(deltaX, deltaY);
    const residual = distance + rangeBias - pseudoranges[receiverIndex]!;
    residuals.push(residual);
    cost += residual * residual;
    jacobianRows.push(distance > 1e-9 ? [deltaX / distance, deltaY / distance, 1] : [0, 0, 1]);
  }
  return { residuals, jacobianRows, cost };
}

function normalMatrixOf(jacobianRows: number[][]): number[][] {
  const normalMatrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const jacobianRow of jacobianRows) {
    for (let rowIndex = 0; rowIndex < 3; rowIndex++) {
      for (let columnIndex = 0; columnIndex < 3; columnIndex++) {
        normalMatrix[rowIndex]![columnIndex]! += jacobianRow[rowIndex]! * jacobianRow[columnIndex]!;
      }
    }
  }
  return normalMatrix;
}

/** Gauss-Newton con amortiguación de Levenberg-Marquardt desde `initialParameters`. */
function refineSolution(
  initialParameters: number[],
  receiverPositions: readonly PlanePoint[],
  pseudoranges: readonly number[],
) {
  let parameters = [...initialParameters];
  let linearized = linearize(parameters, receiverPositions, pseudoranges);
  let damping = 1e-3;
  let iterationCount = 0;
  for (; iterationCount < maximumIterations; iterationCount++) {
    const normalMatrix = normalMatrixOf(linearized.jacobianRows);
    const gradient = [0, 1, 2].map((parameterIndex) =>
      linearized.jacobianRows.reduce(
        (gradientSum, jacobianRow, receiverIndex) => gradientSum + jacobianRow[parameterIndex]! * linearized.residuals[receiverIndex]!,
        0,
      ),
    );
    const dampedMatrix = normalMatrix.map((row, rowIndex) =>
      row.map((entry, columnIndex) => (rowIndex === columnIndex ? entry * (1 + damping) + 1e-12 : entry)),
    );
    const step = solveThreeByThree(
      dampedMatrix,
      gradient.map((gradientValue) => -gradientValue),
    );
    if (!step) break;
    const candidateParameters = parameters.map((parameterValue, parameterIndex) => parameterValue + step[parameterIndex]!);
    const candidateLinearized = linearize(candidateParameters, receiverPositions, pseudoranges);
    if (candidateLinearized.cost <= linearized.cost) {
      parameters = candidateParameters;
      linearized = candidateLinearized;
      damping = Math.max(1e-9, damping / 3);
      if (Math.hypot(step[0]!, step[1]!, step[2]!) < 1e-10) break;
    } else {
      damping *= 4;
      if (damping > 1e9) break;
    }
  }
  return { parameters, linearized, iterationCount };
}

/** Mínimos locales de una rejilla de costes, del más bajo al más alto. */
function findGridStartingPoints(
  receiverPositions: readonly PlanePoint[],
  pseudoranges: readonly number[],
  searchBounds: NonNullable<TdoaSolverOptions['searchBounds']>,
) {
  const { minimumX, maximumX, minimumY, maximumY } = searchBounds;
  const stepX = (maximumX - minimumX) / (gridResolution - 1);
  const stepY = (maximumY - minimumY) / (gridResolution - 1);
  const gridCosts = new Float64Array(gridResolution * gridResolution);
  const gridBiases = new Float64Array(gridResolution * gridResolution);
  for (let rowIndex = 0; rowIndex < gridResolution; rowIndex++) {
    for (let columnIndex = 0; columnIndex < gridResolution; columnIndex++) {
      const { cost, optimalBias } = costWithOptimalBias(
        { x: minimumX + columnIndex * stepX, y: minimumY + rowIndex * stepY },
        receiverPositions,
        pseudoranges,
      );
      gridCosts[rowIndex * gridResolution + columnIndex] = cost;
      gridBiases[rowIndex * gridResolution + columnIndex] = optimalBias;
    }
  }
  const localMinima: { parameters: number[]; cost: number }[] = [];
  for (let rowIndex = 0; rowIndex < gridResolution; rowIndex++) {
    for (let columnIndex = 0; columnIndex < gridResolution; columnIndex++) {
      const cellCost = gridCosts[rowIndex * gridResolution + columnIndex]!;
      let isLocalMinimum = true;
      for (let rowOffset = -1; rowOffset <= 1 && isLocalMinimum; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
          const neighborRow = rowIndex + rowOffset;
          const neighborColumn = columnIndex + columnOffset;
          if ((rowOffset === 0 && columnOffset === 0) || neighborRow < 0 || neighborColumn < 0) continue;
          if (neighborRow >= gridResolution || neighborColumn >= gridResolution) continue;
          if (gridCosts[neighborRow * gridResolution + neighborColumn]! < cellCost) {
            isLocalMinimum = false;
            break;
          }
        }
      }
      if (isLocalMinimum) {
        localMinima.push({
          parameters: [
            minimumX + columnIndex * stepX,
            minimumY + rowIndex * stepY,
            gridBiases[rowIndex * gridResolution + columnIndex]!,
          ],
          cost: cellCost,
        });
      }
    }
  }
  return localMinima.sort((firstMinimum, secondMinimum) => firstMinimum.cost - secondMinimum.cost).slice(0, maximumStartingPoints);
}

export function errorEllipseFromCovariance(
  center: PlanePoint,
  covariance: { xx: number; xy: number; yy: number },
  chiSquareScale = chiSquare95TwoDegrees,
  confidenceLevel = 0.95,
): ErrorEllipse {
  const halfTrace = (covariance.xx + covariance.yy) / 2;
  const halfDifference = (covariance.xx - covariance.yy) / 2;
  const eigenOffset = Math.hypot(halfDifference, covariance.xy);
  const largerEigenvalue = Math.max(0, halfTrace + eigenOffset);
  const smallerEigenvalue = Math.max(0, halfTrace - eigenOffset);
  return {
    center,
    semiMajorAxisMeters: Math.sqrt(largerEigenvalue * chiSquareScale),
    semiMinorAxisMeters: Math.sqrt(smallerEigenvalue * chiSquareScale),
    orientationRadians: 0.5 * Math.atan2(2 * covariance.xy, covariance.xx - covariance.yy),
    confidenceLevel,
  };
}

export function solveTdoaPosition(options: TdoaSolverOptions): TdoaSolution | null {
  const { receiverPositions, pseudorangesMeters, rangeStandardDeviationMeters } = options;
  const receiverCount = receiverPositions.length;
  if (receiverCount < 3 || pseudorangesMeters.length !== receiverCount) return null;
  if (![...pseudorangesMeters, ...receiverPositions.flatMap((point) => [point.x, point.y])].every(Number.isFinite)) {
    return null;
  }
  const searchBounds = options.searchBounds ?? defaultSearchBounds(receiverPositions);

  const refinedSolutions = findGridStartingPoints(receiverPositions, pseudorangesMeters, searchBounds)
    .map((startingPoint) => refineSolution(startingPoint.parameters, receiverPositions, pseudorangesMeters))
    .sort((firstSolution, secondSolution) => firstSolution.linearized.cost - secondSolution.linearized.cost);
  const bestSolution = refinedSolutions[0];
  if (!bestSolution) return null;
  const [positionX, positionY, rangeBias] = bestSolution.parameters as [number, number, number];
  const position = { x: positionX, y: positionY };

  const { residuals, jacobianRows, cost } = bestSolution.linearized;
  const rootMeanSquareResidualMeters = Math.sqrt(cost / receiverCount);
  // Con más micrófonos que incógnitas, los residuos dicen cuánto se equivocan de verdad las medidas.
  const degreesOfFreedom = receiverCount - 3;
  const residualStandardDeviation = degreesOfFreedom > 0 ? Math.sqrt(cost / degreesOfFreedom) : 0;
  const effectiveStandardDeviation = Math.max(rangeStandardDeviationMeters, residualStandardDeviation);

  const inverseNormalMatrix = invertThreeByThree(normalMatrixOf(jacobianRows));
  const positionCovariance = inverseNormalMatrix
    ? {
        xx: inverseNormalMatrix[0]![0]! * effectiveStandardDeviation ** 2,
        xy: inverseNormalMatrix[0]![1]! * effectiveStandardDeviation ** 2,
        yy: inverseNormalMatrix[1]![1]! * effectiveStandardDeviation ** 2,
      }
    : null;
  const errorEllipse =
    positionCovariance && positionCovariance.xx >= 0 && positionCovariance.yy >= 0
      ? errorEllipseFromCovariance(position, positionCovariance)
      : null;

  // Otra solución que explique las medidas casi igual de bien: ambigüedad real.
  const ambiguityCostThreshold = Math.max(2 * cost, cost + 4 * effectiveStandardDeviation ** 2);
  const alternativeSolution = refinedSolutions.slice(1).find((candidateSolution) => {
    const candidatePosition = { x: candidateSolution.parameters[0]!, y: candidateSolution.parameters[1]! };
    return (
      candidateSolution.linearized.cost <= ambiguityCostThreshold &&
      distanceBetween(candidatePosition, position) > duplicateSolutionDistanceMeters
    );
  });

  return {
    position,
    rangeBiasMeters: rangeBias,
    residualsMeters: residuals,
    rootMeanSquareResidualMeters,
    rangeStandardDeviationMeters: effectiveStandardDeviation,
    positionCovariance,
    errorEllipse,
    alternativePosition: alternativeSolution
      ? { x: alternativeSolution.parameters[0]!, y: alternativeSolution.parameters[1]! }
      : null,
    iterationCount: bestSolution.iterationCount,
  };
}

/**
 * Puntos de la rama de hipérbola |x − focoB| − |x − focoA| = `rangeDifferenceMeters`, para
 * dibujarla. `reachMeters` es hasta dónde se alarga desde el centro. `null` si la diferencia es
 * imposible (mayor que la distancia entre los focos: medida incoherente).
 */
export function sampleHyperbolaBranch(
  focusA: PlanePoint,
  focusB: PlanePoint,
  rangeDifferenceMeters: number,
  reachMeters: number,
  pointCount = 64,
): PlanePoint[] | null {
  const focalHalfDistance = distanceBetween(focusA, focusB) / 2;
  const semiTransverseAxis = rangeDifferenceMeters / 2;
  if (!(focalHalfDistance > 0) || Math.abs(semiTransverseAxis) >= focalHalfDistance) return null;
  const semiConjugateAxis = Math.sqrt(focalHalfDistance ** 2 - semiTransverseAxis ** 2);
  const axisX = (focusB.x - focusA.x) / (2 * focalHalfDistance);
  const axisY = (focusB.y - focusA.y) / (2 * focalHalfDistance);
  const centerX = (focusA.x + focusB.x) / 2;
  const centerY = (focusA.y + focusB.y) / 2;
  const maximumParameter = Math.asinh(Math.max(reachMeters, 1) / semiConjugateAxis);
  const branchPoints: PlanePoint[] = [];
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const curveParameter = -maximumParameter + (2 * maximumParameter * pointIndex) / (pointCount - 1);
    // Diferencia positiva: la rama más cerca de A (u < 0 hacia A).
    const alongAxis = -semiTransverseAxis * Math.cosh(curveParameter);
    const acrossAxis = semiConjugateAxis * Math.sinh(curveParameter);
    branchPoints.push({
      x: centerX + alongAxis * axisX - acrossAxis * axisY,
      y: centerY + alongAxis * axisY + acrossAxis * axisX,
    });
  }
  return branchPoints;
}
