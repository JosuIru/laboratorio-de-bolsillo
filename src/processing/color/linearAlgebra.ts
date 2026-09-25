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
