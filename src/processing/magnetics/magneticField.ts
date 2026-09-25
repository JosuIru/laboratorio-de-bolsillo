/**
 * Procesado del campo magnético (µT) para el detector de metales.
 *
 * El magnetómetro mide la suma del campo terrestre (25–65 µT), del campo propio del móvil
 * (imanes del altavoz, piezas de acero: el «hard iron») y de lo que haya cerca. Un objeto de
 * hierro o un imán deforma ese campo unos pocos µT o más a pocos centímetros.
 */

export interface MagneticVector {
  x: number;
  y: number;
  z: number;
}

export function vectorMagnitude(fieldVector: MagneticVector): number {
  return Math.hypot(fieldVector.x, fieldVector.y, fieldVector.z);
}

export function subtractVectors(minuendVector: MagneticVector, subtrahendVector: MagneticVector): MagneticVector {
  return {
    x: minuendVector.x - subtrahendVector.x,
    y: minuendVector.y - subtrahendVector.y,
    z: minuendVector.z - subtrahendVector.z,
  };
}

/**
 * Desviación respecto a la línea base: |B − B0|. La resta vectorial es más sensible que restar
 * módulos: un objeto que gira el campo sin cambiar su intensidad no se vería con |B| − |B0|.
 */
export function deviationFromBaseline(fieldVector: MagneticVector, baselineVector: MagneticVector): number {
  return vectorMagnitude(subtractVectors(fieldVector, baselineVector));
}

export function averageVectors(fieldVectors: readonly MagneticVector[]): MagneticVector | null {
  if (fieldVectors.length === 0) return null;
  const vectorSum = { x: 0, y: 0, z: 0 };
  for (const fieldVector of fieldVectors) {
    vectorSum.x += fieldVector.x;
    vectorSum.y += fieldVector.y;
    vectorSum.z += fieldVector.z;
  }
  return { x: vectorSum.x / fieldVectors.length, y: vectorSum.y / fieldVectors.length, z: vectorSum.z / fieldVectors.length };
}

export interface HardIronOffset {
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export const zeroHardIronOffset: HardIronOffset = { offsetX: 0, offsetY: 0, offsetZ: 0 };

export function applyHardIronOffset(fieldVector: MagneticVector, hardIronOffset: HardIronOffset | null): MagneticVector {
  if (!hardIronOffset) return fieldVector;
  return {
    x: fieldVector.x - hardIronOffset.offsetX,
    y: fieldVector.y - hardIronOffset.offsetY,
    z: fieldVector.z - hardIronOffset.offsetZ,
  };
}

export interface HardIronEstimate {
  hardIronOffset: HardIronOffset;
  /** Recorrido (máx − mín) de cada eje: al girar el móvil del todo, ≈ 2 × campo terrestre. */
  axisRanges: MagneticVector;
  sampleCount: number;
}

/**
 * Estima el offset hard-iron con los extremos de cada eje mientras se gira el móvil en todas
 * direcciones: el centro de la esfera que dibujan las lecturas es el campo propio del móvil,
 * offset = (máx + mín) / 2 por eje.
 */
export function createHardIronEstimator() {
  const minimumVector = { x: Infinity, y: Infinity, z: Infinity };
  const maximumVector = { x: -Infinity, y: -Infinity, z: -Infinity };
  let sampleCount = 0;
  return {
    push(fieldVector: MagneticVector): void {
      for (const axis of ['x', 'y', 'z'] as const) {
        minimumVector[axis] = Math.min(minimumVector[axis], fieldVector[axis]);
        maximumVector[axis] = Math.max(maximumVector[axis], fieldVector[axis]);
      }
      sampleCount++;
    },
    estimate(): HardIronEstimate | null {
      if (sampleCount === 0) return null;
      return {
        hardIronOffset: {
          offsetX: (maximumVector.x + minimumVector.x) / 2,
          offsetY: (maximumVector.y + minimumVector.y) / 2,
          offsetZ: (maximumVector.z + minimumVector.z) / 2,
        },
        axisRanges: {
          x: maximumVector.x - minimumVector.x,
          y: maximumVector.y - minimumVector.y,
          z: maximumVector.z - minimumVector.z,
        },
        sampleCount,
      };
    },
    reset(): void {
      minimumVector.x = minimumVector.y = minimumVector.z = Infinity;
      maximumVector.x = maximumVector.y = maximumVector.z = -Infinity;
      sampleCount = 0;
    },
  };
}

/**
 * Recorrido mínimo por eje para fiarse del offset. Con el campo terrestre más débil (25 µT)
 * un giro completo da 50 µT; pedir 40 deja margen para un giro algo incompleto.
 */
export const minimumCalibrationAxisRangeMicroteslas = 40;

export function isHardIronCoverageSufficient(
  hardIronEstimate: HardIronEstimate,
  minimumAxisRange = minimumCalibrationAxisRangeMicroteslas,
): boolean {
  const { axisRanges } = hardIronEstimate;
  return axisRanges.x >= minimumAxisRange && axisRanges.y >= minimumAxisRange && axisRanges.z >= minimumAxisRange;
}

export type DetectorSensitivity = 'low' | 'medium' | 'high';

/**
 * Umbrales de ΔB (µT) para avisar, con histéresis: se dispara al superar `trigger` y se rearma
 * al bajar de `release`. Con sensibilidad alta, un clavo a 2–3 cm ya avisa; el ruido del
 * magnetómetro de un móvil ronda 0,5–1 µT.
 */
export const detectorThresholdsBySensitivity: Record<DetectorSensitivity, { trigger: number; release: number }> = {
  high: { trigger: 5, release: 3 },
  medium: { trigger: 15, release: 9 },
  low: { trigger: 40, release: 25 },
};
