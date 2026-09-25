import { deltaE2000 } from './colorDifference';
import { type LinearRgb, linearRgbToLab } from './colorSpaces';
import { solveLeastSquares } from './linearAlgebra';

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
  /** ΔE00 medio y máximo de los parches tras corregir: indica la calidad de la calibración. */
  meanResidualDeltaE: number;
  maximumResidualDeltaE: number;
}

export const minimumPatchesByModel: Record<ColorCorrectionModel, number> = { diagonal: 1, linear: 3, affine: 4 };

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

export function fitColorCorrection(
  patchMeasurements: readonly ReferencePatchMeasurement[],
  model: ColorCorrectionModel,
): ColorCorrection {
  if (patchMeasurements.length < minimumPatchesByModel[model]) throw new ColorCorrectionError('not-enough-patches');

  const matrixRows = channelNames.map((targetChannel, targetChannelIndex) => {
    const targets = patchMeasurements.map((patch) => patch.reference[targetChannel]);

    if (model === 'diagonal') {
      const measuredValues = patchMeasurements.map((patch) => patch.measured[targetChannel]);
      const solution = solveLeastSquares(
        measuredValues.map((measuredValue) => [measuredValue]),
        targets,
      );
      if (!solution) throw new ColorCorrectionError('degenerate-patches');
      const diagonalRow = [0, 0, 0, 0];
      diagonalRow[targetChannelIndex] = solution[0]!;
      return diagonalRow;
    }

    const designRows = patchMeasurements.map(({ measured }) =>
      model === 'affine' ? [measured.red, measured.green, measured.blue, 1] : [measured.red, measured.green, measured.blue],
    );
    const solution = solveLeastSquares(designRows, targets);
    if (!solution) throw new ColorCorrectionError('degenerate-patches');
    return model === 'affine' ? solution : [...solution, 0];
  }) as [number[], number[], number[]];

  const residualDifferences = patchMeasurements.map((patch) =>
    deltaE2000(linearRgbToLab(applyColorCorrection({ matrixRows }, patch.measured)), linearRgbToLab(patch.reference)),
  );
  return {
    model,
    matrixRows,
    meanResidualDeltaE: residualDifferences.reduce((differenceSum, difference) => differenceSum + difference, 0) /
      residualDifferences.length,
    maximumResidualDeltaE: Math.max(...residualDifferences),
  };
}

/** El modelo más completo que admite el número de parches disponible. */
export function bestModelForPatchCount(patchCount: number): ColorCorrectionModel | null {
  if (patchCount >= minimumPatchesByModel.affine) return 'affine';
  if (patchCount >= minimumPatchesByModel.linear) return 'linear';
  if (patchCount >= minimumPatchesByModel.diagonal) return 'diagonal';
  return null;
}
