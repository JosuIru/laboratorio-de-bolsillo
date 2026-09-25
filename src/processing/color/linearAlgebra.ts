/**
 * Resuelve A·x = b (A cuadrada, pequeña) por eliminación gaussiana con pivoteo parcial.
 * Devuelve null si el sistema es singular o está muy mal condicionado.
 */
export function solveLinearSystem(matrix: readonly (readonly number[])[], rightHandSide: readonly number[]): number[] | null {
  const size = matrix.length;
  const augmentedRows = matrix.map((row, rowIndex) => [...row, rightHandSide[rowIndex]!]);

  for (let pivotColumn = 0; pivotColumn < size; pivotColumn++) {
    let pivotRow = pivotColumn;
    for (let candidateRow = pivotColumn + 1; candidateRow < size; candidateRow++) {
      if (Math.abs(augmentedRows[candidateRow]![pivotColumn]!) > Math.abs(augmentedRows[pivotRow]![pivotColumn]!)) {
        pivotRow = candidateRow;
      }
    }
    if (Math.abs(augmentedRows[pivotRow]![pivotColumn]!) < 1e-12) return null;
    [augmentedRows[pivotColumn], augmentedRows[pivotRow]] = [augmentedRows[pivotRow]!, augmentedRows[pivotColumn]!];

    const pivotValue = augmentedRows[pivotColumn]![pivotColumn]!;
    for (let targetRow = pivotColumn + 1; targetRow < size; targetRow++) {
      const eliminationFactor = augmentedRows[targetRow]![pivotColumn]! / pivotValue;
      for (let columnIndex = pivotColumn; columnIndex <= size; columnIndex++) {
        augmentedRows[targetRow]![columnIndex]! -= eliminationFactor * augmentedRows[pivotColumn]![columnIndex]!;
      }
    }
  }

  const solution = new Array<number>(size).fill(0);
  for (let rowIndex = size - 1; rowIndex >= 0; rowIndex--) {
    let accumulatedSum = augmentedRows[rowIndex]![size]!;
    for (let columnIndex = rowIndex + 1; columnIndex < size; columnIndex++) {
      accumulatedSum -= augmentedRows[rowIndex]![columnIndex]! * solution[columnIndex]!;
    }
    solution[rowIndex] = accumulatedSum / augmentedRows[rowIndex]![rowIndex]!;
  }
  return solution;
}

/**
 * Mínimos cuadrados: encuentra x que minimiza ‖D·x − t‖² resolviendo las ecuaciones normales
 * (Dᵀ·D)·x = Dᵀ·t. Suficiente para los sistemas pequeños y bien planteados de la calibración.
 */
export function solveLeastSquares(designRows: readonly (readonly number[])[], targets: readonly number[]): number[] | null {
  const unknownCount = designRows[0]?.length ?? 0;
  if (unknownCount === 0 || designRows.length < unknownCount) return null;
  const normalMatrix = Array.from({ length: unknownCount }, () => new Array<number>(unknownCount).fill(0));
  const normalRightHandSide = new Array<number>(unknownCount).fill(0);
  designRows.forEach((designRow, observationIndex) => {
    for (let rowIndex = 0; rowIndex < unknownCount; rowIndex++) {
      normalRightHandSide[rowIndex]! += designRow[rowIndex]! * targets[observationIndex]!;
      for (let columnIndex = 0; columnIndex < unknownCount; columnIndex++) {
        normalMatrix[rowIndex]![columnIndex]! += designRow[rowIndex]! * designRow[columnIndex]!;
      }
    }
  });
  return solveLinearSystem(normalMatrix, normalRightHandSide);
}

/**
 * Autovalores de una matriz simétrica pequeña por el método de Jacobi (rotaciones que anulan
 * los elementos fuera de la diagonal). Sin orden particular.
 */
export function symmetricEigenvalues(symmetricMatrix: readonly (readonly number[])[]): number[] {
  const size = symmetricMatrix.length;
  const workingMatrix = symmetricMatrix.map((row) => [...row]);
  const maximumSweeps = 50;

  for (let sweepIndex = 0; sweepIndex < maximumSweeps; sweepIndex++) {
    let offDiagonalSquaredSum = 0;
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      for (let columnIndex = rowIndex + 1; columnIndex < size; columnIndex++) {
        offDiagonalSquaredSum += workingMatrix[rowIndex]![columnIndex]! ** 2;
      }
    }
    if (offDiagonalSquaredSum < 1e-30) break;

    for (let pivotRow = 0; pivotRow < size; pivotRow++) {
      for (let pivotColumn = pivotRow + 1; pivotColumn < size; pivotColumn++) {
        const offDiagonalValue = workingMatrix[pivotRow]![pivotColumn]!;
        if (Math.abs(offDiagonalValue) < 1e-300) continue;
        // Rotación de Givens que anula el elemento (pivotRow, pivotColumn).
        const rotationTheta =
          (workingMatrix[pivotColumn]![pivotColumn]! - workingMatrix[pivotRow]![pivotRow]!) / (2 * offDiagonalValue);
        const rotationTangent =
          (rotationTheta >= 0 ? 1 : -1) / (Math.abs(rotationTheta) + Math.sqrt(rotationTheta * rotationTheta + 1));
        const rotationCosine = 1 / Math.sqrt(rotationTangent * rotationTangent + 1);
        const rotationSine = rotationTangent * rotationCosine;

        for (let otherIndex = 0; otherIndex < size; otherIndex++) {
          const pivotRowValue = workingMatrix[otherIndex]![pivotRow]!;
          const pivotColumnValue = workingMatrix[otherIndex]![pivotColumn]!;
          workingMatrix[otherIndex]![pivotRow] = rotationCosine * pivotRowValue - rotationSine * pivotColumnValue;
          workingMatrix[otherIndex]![pivotColumn] = rotationSine * pivotRowValue + rotationCosine * pivotColumnValue;
        }
        for (let otherIndex = 0; otherIndex < size; otherIndex++) {
          const pivotRowValue = workingMatrix[pivotRow]![otherIndex]!;
          const pivotColumnValue = workingMatrix[pivotColumn]![otherIndex]!;
          workingMatrix[pivotRow]![otherIndex] = rotationCosine * pivotRowValue - rotationSine * pivotColumnValue;
          workingMatrix[pivotColumn]![otherIndex] = rotationSine * pivotRowValue + rotationCosine * pivotColumnValue;
        }
      }
    }
  }
  return workingMatrix.map((row, diagonalIndex) => row[diagonalIndex]!);
}

/**
 * Número de condición de la matriz normal Dᵀ·D (cociente entre su autovalor mayor y el menor).
 * Mide cuánto amplifica el ajuste por mínimos cuadrados el ruido de las medidas: si las filas de
 * D son casi dependientes (p. ej. solo parches grises), se dispara. Infinito si es singular.
 */
export function normalMatrixConditionNumber(designRows: readonly (readonly number[])[]): number {
  const unknownCount = designRows[0]?.length ?? 0;
  if (unknownCount === 0 || designRows.length < unknownCount) return Number.POSITIVE_INFINITY;
  const normalMatrix = Array.from({ length: unknownCount }, (_, rowIndex) =>
    Array.from({ length: unknownCount }, (_, columnIndex) =>
      designRows.reduce((productSum, designRow) => productSum + designRow[rowIndex]! * designRow[columnIndex]!, 0),
    ),
  );
  const eigenvalues = symmetricEigenvalues(normalMatrix);
  const largestEigenvalue = Math.max(...eigenvalues);
  const smallestEigenvalue = Math.min(...eigenvalues);
  if (!(largestEigenvalue > 0) || smallestEigenvalue <= largestEigenvalue * 1e-15) return Number.POSITIVE_INFINITY;
  return largestEigenvalue / smallestEigenvalue;
}
