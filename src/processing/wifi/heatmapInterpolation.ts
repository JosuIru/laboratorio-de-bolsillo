import {
  isPointInsideHouse,
  planDistance,
  type PlanPoint,
  type PlanRoom,
  type SignalMeasurementPoint,
} from './floorPlan';
import { deadZoneThresholdDbm } from './rssiStatistics';

/**
 * Mapa de calor por interpolación de distancia inversa (IDW): cada celda toma la media de los
 * puntos medidos ponderada por 1 / distanciaᵖ. No sabe nada de paredes: entre dos medidas
 * supone una transición suave, así que el mapa es tan bueno como la densidad de puntos.
 */

export interface HeatmapGrid {
  columnCount: number;
  rowCount: number;
  /** RSSI interpolado por celda (fila a fila), en dBm. NaN fuera de la casa o sin medidas. */
  rssiDbm: Float32Array;
  /** Distancia (en anchos de plano) de cada celda al punto medido más cercano. */
  nearestMeasurementDistance: Float32Array;
  /** 1 si la celda está dentro de alguna habitación (o no hay habitaciones), 0 si no. */
  insideHouse: Uint8Array;
}

export interface HeatmapOptions {
  columnCount: number;
  rowCount: number;
  /** Alto / ancho del plano. */
  aspectRatio: number;
  rooms: readonly PlanRoom[];
  /** Exponente de IDW: 2 es el valor clásico; más alto = zonas más marcadas alrededor de cada punto. */
  idwPower?: number;
}

/** Centro de la celda (columna, fila) en coordenadas normalizadas. */
export function cellCenter(columnIndex: number, rowIndex: number, columnCount: number, rowCount: number): PlanPoint {
  return { x: (columnIndex + 0.5) / columnCount, y: (rowIndex + 0.5) / rowCount };
}

/** Valor IDW en un punto. `null` sin puntos medidos. */
export function interpolateRssiAt(
  targetPoint: PlanPoint,
  measurementPoints: readonly SignalMeasurementPoint[],
  aspectRatio: number,
  idwPower = 2,
): number | null {
  if (measurementPoints.length === 0) return null;
  let weightedSum = 0;
  let weightSum = 0;
  for (const measurementPoint of measurementPoints) {
    const distance = planDistance(targetPoint, measurementPoint, aspectRatio);
    // Encima de un punto medido se devuelve su valor exacto (IDW es un interpolador exacto).
    if (distance < 1e-9) return measurementPoint.rssiDbm;
    const weight = 1 / distance ** idwPower;
    weightedSum += weight * measurementPoint.rssiDbm;
    weightSum += weight;
  }
  return weightedSum / weightSum;
}

export function interpolateHeatmap(
  measurementPoints: readonly SignalMeasurementPoint[],
  options: HeatmapOptions,
): HeatmapGrid {
  const { columnCount, rowCount, aspectRatio, rooms } = options;
  const idwPower = options.idwPower ?? 2;
  const cellCount = columnCount * rowCount;
  const rssiDbm = new Float32Array(cellCount).fill(Number.NaN);
  const nearestMeasurementDistance = new Float32Array(cellCount).fill(Number.POSITIVE_INFINITY);
  const insideHouse = new Uint8Array(cellCount);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const cellIndex = rowIndex * columnCount + columnIndex;
      const centerPoint = cellCenter(columnIndex, rowIndex, columnCount, rowCount);
      if (!isPointInsideHouse(centerPoint, rooms)) continue;
      insideHouse[cellIndex] = 1;
      for (const measurementPoint of measurementPoints) {
        const distance = planDistance(centerPoint, measurementPoint, aspectRatio);
        if (distance < nearestMeasurementDistance[cellIndex]!) nearestMeasurementDistance[cellIndex] = distance;
      }
      const interpolatedValue = interpolateRssiAt(centerPoint, measurementPoints, aspectRatio, idwPower);
      if (interpolatedValue !== null) rssiDbm[cellIndex] = interpolatedValue;
    }
  }
  return { columnCount, rowCount, rssiDbm, nearestMeasurementDistance, insideHouse };
}

/**
 * Más allá de esta distancia a la medida más cercana (en anchos de plano) el mapa es una
 * extrapolación: se pinta atenuado y no cuenta para zonas muertas ni recomendaciones.
 */
export const defaultSupportRadius = 0.3;

export interface DeadZoneSummary {
  /** Celdas dentro de casa y con medidas cerca. */
  coveredCellCount: number;
  deadCellCount: number;
  /** Fracción (0-1) de la zona cubierta por debajo del umbral. */
  deadFraction: number;
  /** Centro de gravedad de las celdas muertas, o null si no hay. */
  deadZoneCentroid: PlanPoint | null;
}

export function summarizeDeadZones(
  heatmapGrid: HeatmapGrid,
  supportRadius = defaultSupportRadius,
  thresholdDbm = deadZoneThresholdDbm,
): DeadZoneSummary {
  let coveredCellCount = 0;
  let deadCellCount = 0;
  let centroidXSum = 0;
  let centroidYSum = 0;
  forEachSupportedCell(heatmapGrid, supportRadius, (cellRssi, centerPoint) => {
    coveredCellCount++;
    if (cellRssi < thresholdDbm) {
      deadCellCount++;
      centroidXSum += centerPoint.x;
      centroidYSum += centerPoint.y;
    }
  });
  return {
    coveredCellCount,
    deadCellCount,
    deadFraction: coveredCellCount > 0 ? deadCellCount / coveredCellCount : 0,
    deadZoneCentroid:
      deadCellCount > 0 ? { x: centroidXSum / deadCellCount, y: centroidYSum / deadCellCount } : null,
  };
}

/** Recorre las celdas dentro de casa, con valor y con una medida a menos de `supportRadius`. */
export function forEachSupportedCell(
  heatmapGrid: HeatmapGrid,
  supportRadius: number,
  visitCell: (cellRssi: number, centerPoint: PlanPoint, cellIndex: number) => void,
): void {
  const { columnCount, rowCount } = heatmapGrid;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const cellIndex = rowIndex * columnCount + columnIndex;
      const cellRssi = heatmapGrid.rssiDbm[cellIndex]!;
      if (heatmapGrid.insideHouse[cellIndex] !== 1 || Number.isNaN(cellRssi)) continue;
      if (heatmapGrid.nearestMeasurementDistance[cellIndex]! > supportRadius) continue;
      visitCell(cellRssi, cellCenter(columnIndex, rowIndex, columnCount, rowCount), cellIndex);
    }
  }
}

/** Escala de color del mapa: rojo (malo) → amarillo → verde (bueno). */
export const heatmapColorScaleDbm = { worst: -90, middle: -70, best: -50 } as const;

type RgbColor = readonly [number, number, number];

const worstColor: RgbColor = [200, 40, 40];
const middleColor: RgbColor = [235, 200, 50];
const bestColor: RgbColor = [40, 170, 80];

function mixColors(firstColor: RgbColor, secondColor: RgbColor, fraction: number): RgbColor {
  return [
    firstColor[0] + (secondColor[0] - firstColor[0]) * fraction,
    firstColor[1] + (secondColor[1] - firstColor[1]) * fraction,
    firstColor[2] + (secondColor[2] - firstColor[2]) * fraction,
  ];
}

export function colorForRssi(rssiDbm: number): RgbColor {
  const { worst, middle, best } = heatmapColorScaleDbm;
  if (rssiDbm <= worst) return worstColor;
  if (rssiDbm >= best) return bestColor;
  if (rssiDbm < middle) return mixColors(worstColor, middleColor, (rssiDbm - worst) / (middle - worst));
  return mixColors(middleColor, bestColor, (rssiDbm - middle) / (best - middle));
}

/**
 * Pinta el mapa en un buffer RGBA (sin premultiplicar) de `columnCount × rowCount` píxeles.
 * Fuera de casa queda transparente; lejos de las medidas, semitransparente; en las zonas
 * muertas se añaden rayas diagonales oscuras para que se vean sin depender del color.
 */
export function renderHeatmapPixels(
  heatmapGrid: HeatmapGrid,
  pixels: Uint8Array,
  supportRadius = defaultSupportRadius,
  deadThresholdDbm = deadZoneThresholdDbm,
): void {
  const { columnCount, rowCount } = heatmapGrid;
  const stripePeriodCells = Math.max(3, Math.round(columnCount / 12));
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const cellIndex = rowIndex * columnCount + columnIndex;
      const pixelOffset = cellIndex * 4;
      const cellRssi = heatmapGrid.rssiDbm[cellIndex]!;
      if (heatmapGrid.insideHouse[cellIndex] !== 1 || Number.isNaN(cellRssi)) {
        pixels[pixelOffset] = 0;
        pixels[pixelOffset + 1] = 0;
        pixels[pixelOffset + 2] = 0;
        pixels[pixelOffset + 3] = 0;
        continue;
      }
      let [red, green, blue] = colorForRssi(cellRssi);
      const isSupported = heatmapGrid.nearestMeasurementDistance[cellIndex]! <= supportRadius;
      const isStripe = (columnIndex + rowIndex) % stripePeriodCells === 0;
      if (isSupported && cellRssi < deadThresholdDbm && isStripe) {
        red *= 0.35;
        green *= 0.35;
        blue *= 0.35;
      }
      pixels[pixelOffset] = Math.round(red);
      pixels[pixelOffset + 1] = Math.round(green);
      pixels[pixelOffset + 2] = Math.round(blue);
      pixels[pixelOffset + 3] = isSupported ? 210 : 80;
    }
  }
}
