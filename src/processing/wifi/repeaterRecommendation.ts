import { planDistance, type PlanPoint } from './floorPlan';
import { defaultSupportRadius, forEachSupportedCell, type HeatmapGrid, summarizeDeadZones } from './heatmapInterpolation';

/**
 * Dónde poner un repetidor: debe recibir todavía buena señal del router (si no, repite una
 * señal mala) y estar lo más cerca posible de la zona muerta. La regla práctica es «a medio
 * camino, donde aún hay unos −65/−70 dBm»; aquí se busca, entre las celdas con señal suficiente,
 * la más cercana al centro de la zona muerta.
 */

/** Señal mínima en el sitio del repetidor. */
export const minimumRepeaterRssiDbm = -70;
/** Con menos puntos el mapa no es fiable para recomendar nada. */
export const minimumPointsForRecommendation = 4;

export type RepeaterRecommendation =
  | { status: 'recommended'; location: PlanPoint; rssiDbm: number; deadZoneCentroid: PlanPoint; deadFraction: number }
  | { status: 'not-enough-points' }
  | { status: 'no-dead-zone' }
  /** Hay zona muerta pero ningún sitio medido con señal suficiente: mejor mover el router o usar malla/PLC. */
  | { status: 'no-good-spot'; deadZoneCentroid: PlanPoint; deadFraction: number };

export function recommendRepeaterLocation(
  heatmapGrid: HeatmapGrid,
  measuredPointCount: number,
  aspectRatio: number,
  supportRadius = defaultSupportRadius,
): RepeaterRecommendation {
  if (measuredPointCount < minimumPointsForRecommendation) return { status: 'not-enough-points' };
  const deadZoneSummary = summarizeDeadZones(heatmapGrid, supportRadius);
  const { deadZoneCentroid, deadFraction } = deadZoneSummary;
  if (deadZoneCentroid === null) return { status: 'no-dead-zone' };

  let bestLocation: PlanPoint | null = null;
  let bestRssi = Number.NEGATIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  forEachSupportedCell(heatmapGrid, supportRadius, (cellRssi, centerPoint) => {
    if (cellRssi < minimumRepeaterRssiDbm) return;
    const distanceToDeadZone = planDistance(centerPoint, deadZoneCentroid, aspectRatio);
    const isCloser = distanceToDeadZone < bestDistance - 1e-6;
    const isTieWithBetterSignal = Math.abs(distanceToDeadZone - bestDistance) <= 1e-6 && cellRssi > bestRssi;
    if (isCloser || isTieWithBetterSignal) {
      bestLocation = centerPoint;
      bestRssi = cellRssi;
      bestDistance = distanceToDeadZone;
    }
  });

  if (bestLocation === null) return { status: 'no-good-spot', deadZoneCentroid, deadFraction };
  return { status: 'recommended', location: bestLocation, rssiDbm: bestRssi, deadZoneCentroid, deadFraction };
}
