import {
  distanceBetween,
  type PlanePoint,
  pseudorangesFromIntervals,
  solveTdoaPosition,
  type TdoaSolution,
} from '@/processing/localization/multilateration';
import { speedOfSoundMetersPerSecond } from '@/processing/sonar/soundSpeed';
import { parseDecimalInput } from '@/ui/decimalInput';

import { rangeStandardDeviationMeters } from './locatorConfiguration';

/** Una fila de la tabla tal como la escribe el usuario. */
export interface ReceiverRow {
  xText: string;
  yText: string;
  /** Intervalo chirrido → palmada en ms, como lo enseña cada móvil. */
  intervalText: string;
}

export interface LocationEstimate {
  receiverPositions: PlanePoint[];
  intervalsSeconds: number[];
  pseudorangesMeters: number[];
  speedOfSoundMetersPerSecond: number;
  solution: TdoaSolution | null;
  /** Móviles (índices) cuya diferencia con A es imposible: más que la distancia entre ambos. */
  impossibleReceiverIndices: number[];
  /** Los residuos son mucho mayores de lo esperable: algún número o posición está mal. */
  isInconsistent: boolean;
  /** La fuente está lejos del grupo de móviles: la precisión cae deprisa. */
  isFarOutside: boolean;
}

export type ParsedRows =
  | { status: 'ok'; receiverPositions: PlanePoint[]; intervalsSeconds: number[] }
  | { status: 'incomplete' }
  | { status: 'duplicatePositions' };

export function parseReceiverRows(receiverRows: readonly ReceiverRow[]): ParsedRows {
  const receiverPositions: PlanePoint[] = [];
  const intervalsSeconds: number[] = [];
  for (const receiverRow of receiverRows) {
    const positionX = parseDecimalInput(receiverRow.xText);
    const positionY = parseDecimalInput(receiverRow.yText);
    const intervalMilliseconds = parseDecimalInput(receiverRow.intervalText);
    if (positionX === null || positionY === null || intervalMilliseconds === null) return { status: 'incomplete' };
    receiverPositions.push({ x: positionX, y: positionY });
    intervalsSeconds.push(intervalMilliseconds / 1000);
  }
  for (let firstIndex = 0; firstIndex < receiverPositions.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < receiverPositions.length; secondIndex++) {
      if (distanceBetween(receiverPositions[firstIndex]!, receiverPositions[secondIndex]!) < 0.05) {
        return { status: 'duplicatePositions' };
      }
    }
  }
  return { status: 'ok', receiverPositions, intervalsSeconds };
}

export function estimateLocation(
  receiverPositions: PlanePoint[],
  intervalsSeconds: number[],
  emitterIndex: number,
  temperatureCelsius: number,
): LocationEstimate {
  const speedOfSound = speedOfSoundMetersPerSecond(temperatureCelsius);
  const emitterPosition = receiverPositions[emitterIndex] ?? receiverPositions[0]!;
  const pseudorangesMeters = pseudorangesFromIntervals(intervalsSeconds, receiverPositions, emitterPosition, speedOfSound);
  const priorStandardDeviation = rangeStandardDeviationMeters(speedOfSound);
  const solution = solveTdoaPosition({
    receiverPositions,
    pseudorangesMeters,
    rangeStandardDeviationMeters: priorStandardDeviation,
  });

  const referencePosition = receiverPositions[0]!;
  const impossibleReceiverIndices = receiverPositions
    .map((receiverPosition, receiverIndex) => ({ receiverPosition, receiverIndex }))
    .filter(
      ({ receiverPosition, receiverIndex }) =>
        receiverIndex > 0 &&
        Math.abs(pseudorangesMeters[receiverIndex]! - pseudorangesMeters[0]!) >=
          distanceBetween(receiverPosition, referencePosition),
    )
    .map(({ receiverIndex }) => receiverIndex);

  const centroid = {
    x: receiverPositions.reduce((sum, point) => sum + point.x, 0) / receiverPositions.length,
    y: receiverPositions.reduce((sum, point) => sum + point.y, 0) / receiverPositions.length,
  };
  const arrayRadius = Math.max(...receiverPositions.map((point) => distanceBetween(point, centroid)));

  return {
    receiverPositions,
    intervalsSeconds,
    pseudorangesMeters,
    speedOfSoundMetersPerSecond: speedOfSound,
    solution,
    impossibleReceiverIndices,
    isInconsistent: solution !== null && solution.rootMeanSquareResidualMeters > 3 * priorStandardDeviation,
    isFarOutside: solution !== null && distanceBetween(solution.position, centroid) > 2 * arrayRadius,
  };
}
