import { deltaE2000 } from './colorDifference';
import { type LinearRgb, linearRgbToLab } from './colorSpaces';
import { normalMatrixConditionNumber, solveLeastSquares } from './linearAlgebra';

/**
 * Corrección de color con una tarjeta de referencia fotografiada en el mismo encuadre:
 * se ajusta una transformación que lleva el RGB lineal medido por la cámara al RGB lineal
 * conocido de cada parche, y después se aplica a la muestra.
 *
 * Modelos, de menos a más parámetros (y parches necesarios):
 * - `diagonal`: balance de blancos por canal (≥ 1 parche, idealmente blanco o gris).
 * - `linear`: matriz 3×3 (≥ 3 parches de colores distintos).
 * - `affine`: matriz 3×3 + desplazamiento, compensa también luz parásita (≥ 4 parches).
 */
export type ColorCorrectionModel = 'diagonal' | 'linear' | 'affine';

export interface ReferencePatchMeasurement {
  measured: LinearRgb;
  reference: LinearRgb;
}

export interface ColorCorrection {
  model: ColorCorrectionModel;
  /** Filas de la matriz 3×4 (la última columna es el desplazamiento; 0 salvo en `affine`). */
  matrixRows: [number[], number[], number[]];
  /** Parches con los que se ha ajustado (en el balance de blancos, solo los neutros si los hay). */
  fittedPatchCount: number;
  /**
   * ΔE00 medio y máximo de validación cruzada dejando uno fuera: cada parche se predice con la
   * corrección ajustada sin él. Es null si no hay más parches que incógnitas por canal, porque
   * entonces el ajuste es exacto y el residuo (≈ 0) no dice nada de la calidad.
   */
  meanValidationDeltaE: number | null;
  maximumValidationDeltaE: number | null;
  /** Había parches para una matriz, pero sus colores eran demasiado parecidos (p. ej. solo grises). */
  isReducedToWhiteBalance: boolean;
}

export const minimumPatchesByModel: Record<ColorCorrectionModel, number> = { diagonal: 1, linear: 3, affine: 4 };

/**
 * Número de condición máximo de Dᵀ·D para aceptar una matriz. Simulando una cámara con ruido,
 * los 6 parches de un ColorChecker dan ~10² (lineal) y ~2·10² (afín), y sin el azul ~10³; con
 * grises y un solo color, ~6·10³ (lineal); con solo grises (colineales en RGB), más de 10⁶.
 */
export const maximumNormalMatrixConditionNumber = 3e3;

/** Croma CIELAB por debajo de la cual un parche de referencia se considera neutro. */
const neutralPatchMaximumChroma = 10;

const channelNames = ['red', 'green', 'blue'] as const;

export class ColorCorrectionError extends Error {
  constructor(readonly reason: 'not-enough-patches' | 'degenerate-patches') {
    super(reason === 'not-enough-patches' ? 'Faltan parches de referencia' : 'Los parches no permiten calibrar');
    this.name = 'ColorCorrectionError';
  }
}

export function applyColorCorrection(correction: Pick<ColorCorrection, 'matrixRows'>, measuredColor: LinearRgb): LinearRgb {
  'worklet';
  const [redRow, greenRow, blueRow] = correction.matrixRows;
  const correctChannel = (matrixRow: number[]) =>
    matrixRow[0]! * measuredColor.red + matrixRow[1]! * measuredColor.green + matrixRow[2]! * measuredColor.blue + matrixRow[3]!;
  return { red: correctChannel(redRow), green: correctChannel(greenRow), blue: correctChannel(blueRow) };
}

function designRowFor(measured: LinearRgb, model: Exclude<ColorCorrectionModel, 'diagonal'>): number[] {
  return model === 'affine' ? [measured.red, measured.green, measured.blue, 1] : [measured.red, measured.green, measured.blue];
}

/** Ajusta la matriz por mínimos cuadrados; null si los parches son degenerados. */
function fitMatrixRows(
  patchMeasurements: readonly ReferencePatchMeasurement[],
  model: ColorCorrectionModel,
): [number[], number[], number[]] | null {
  const matrixRows: number[][] = [];
  for (const [targetChannelIndex, targetChannel] of channelNames.entries()) {
    const targets = patchMeasurements.map((patch) => patch.reference[targetChannel]);

    if (model === 'diagonal') {
      const solution = solveLeastSquares(
        patchMeasurements.map((patch) => [patch.measured[targetChannel]]),
        targets,
      );
      if (!solution) return null;
      const diagonalRow = [0, 0, 0, 0];
      diagonalRow[targetChannelIndex] = solution[0]!;
      matrixRows.push(diagonalRow);
      continue;
    }

    const solution = solveLeastSquares(
      patchMeasurements.map(({ measured }) => designRowFor(measured, model)),
      targets,
    );
    if (!solution) return null;
    matrixRows.push(model === 'affine' ? solution : [...solution, 0]);
  }
  return matrixRows as [number[], number[], number[]];
}

function patchDeltaE(matrixRows: [number[], number[], number[]], patch: ReferencePatchMeasurement): number {
  return deltaE2000(linearRgbToLab(applyColorCorrection({ matrixRows }, patch.measured)), linearRgbToLab(patch.reference));
}

/** Validación dejando uno fuera; null si no hay parches de sobra o algún subconjunto es degenerado. */
function leaveOneOutDeltaE(
  patchMeasurements: readonly ReferencePatchMeasurement[],
  model: ColorCorrectionModel,
): { mean: number; maximum: number } | null {
  if (patchMeasurements.length <= minimumPatchesByModel[model]) return null;
  const validationDifferences: number[] = [];
  for (const [heldOutIndex, heldOutPatch] of patchMeasurements.entries()) {
    const trainingPatches = patchMeasurements.filter((_, patchIndex) => patchIndex !== heldOutIndex);
    const trainingMatrixRows = fitMatrixRows(trainingPatches, model);
    if (!trainingMatrixRows) return null;
    validationDifferences.push(patchDeltaE(trainingMatrixRows, heldOutPatch));
  }
  return {
    mean: validationDifferences.reduce((differenceSum, difference) => differenceSum + difference, 0) / validationDifferences.length,
    maximum: Math.max(...validationDifferences),
  };
}

export function fitColorCorrection(
  patchMeasurements: readonly ReferencePatchMeasurement[],
  model: ColorCorrectionModel,
): ColorCorrection {
  if (patchMeasurements.length < minimumPatchesByModel[model]) throw new ColorCorrectionError('not-enough-patches');
  const matrixRows = fitMatrixRows(patchMeasurements, model);
  if (!matrixRows) throw new ColorCorrectionError('degenerate-patches');
  const validation = leaveOneOutDeltaE(patchMeasurements, model);
  return {
    model,
    matrixRows,
    fittedPatchCount: patchMeasurements.length,
    meanValidationDeltaE: validation?.mean ?? null,
    maximumValidationDeltaE: validation?.maximum ?? null,
    isReducedToWhiteBalance: false,
  };
}

/** Número de condición de las medidas para un modelo con matriz (infinito si faltan parches). */
export function patchConditionNumber(
  patchMeasurements: readonly ReferencePatchMeasurement[],
  model: Exclude<ColorCorrectionModel, 'diagonal'>,
): number {
  return normalMatrixConditionNumber(patchMeasurements.map(({ measured }) => designRowFor(measured, model)));
}

/**
 * El modelo más completo que las medidas permiten ajustar con estabilidad: no basta con el número
 * de parches, sus colores medidos tienen que abarcar las tres dimensiones del RGB (si no, la
 * matriz amplifica el ruido y deforma los colores que no están en la tarjeta).
 */
export function bestModelForPatches(patchMeasurements: readonly ReferencePatchMeasurement[]): ColorCorrectionModel | null {
  for (const matrixModel of ['affine', 'linear'] as const) {
    if (
      patchMeasurements.length >= minimumPatchesByModel[matrixModel] &&
      patchConditionNumber(patchMeasurements, matrixModel) <= maximumNormalMatrixConditionNumber
    ) {
      return matrixModel;
    }
  }
  return patchMeasurements.length >= minimumPatchesByModel.diagonal ? 'diagonal' : null;
}

export function isNeutralReference(referenceColor: LinearRgb): boolean {
  const referenceLab = linearRgbToLab(referenceColor);
  return Math.hypot(referenceLab.greenRed, referenceLab.blueYellow) < neutralPatchMaximumChroma;
}

/**
 * Elige el modelo según el condicionamiento de las medidas y ajusta la corrección. Si se queda en
 * balance de blancos, lo ajusta solo con los parches neutros (si hay alguno): un parche de color
 * saturado desviaría la ganancia de los canales. Null si no hay parches o son degenerados.
 */
export function chooseColorCorrection(patchMeasurements: readonly ReferencePatchMeasurement[]): ColorCorrection | null {
  const model = bestModelForPatches(patchMeasurements);
  if (!model) return null;
  const neutralPatches = patchMeasurements.filter((patch) => isNeutralReference(patch.reference));
  const fittedPatches = model === 'diagonal' && neutralPatches.length > 0 ? neutralPatches : patchMeasurements;
  try {
    const correction = fitColorCorrection(fittedPatches, model);
    return {
      ...correction,
      isReducedToWhiteBalance: model === 'diagonal' && patchMeasurements.length >= minimumPatchesByModel.linear,
    };
  } catch (fitError) {
    // Parches degenerados (p. ej. todos negros): se mide sin corregir.
    if (fitError instanceof ColorCorrectionError) return null;
    throw fitError;
  }
}
