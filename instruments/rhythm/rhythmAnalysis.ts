/**
 * Análisis de «Mantén el pulso» (tarea de continuación del tapping) y de palmas libres.
 *
 * Todo ocurre en la línea de tiempo del micrófono: los clics de entrada que suenan por el
 * altavoz también se oyen, y de ellos sale la rejilla de pulsos. Así la latencia del altavoz y
 * del micrófono, distinta en cada móvil, no afecta a la medida.
 */

import { estimateTempo } from '@/processing/dsp/onsets';

export interface BeatGrid {
  /** Instante (s) del pulso 0 en la línea de tiempo del micrófono. */
  firstBeatSeconds: number;
  periodSeconds: number;
}

export function beatTimeSeconds(beatGrid: BeatGrid, beatIndex: number): number {
  return beatGrid.firstBeatSeconds + beatIndex * beatGrid.periodSeconds;
}

/** Recta de mínimos cuadrados t = a + b·k. */
function fitLine(points: readonly { beatIndex: number; timeSeconds: number }[]): BeatGrid {
  const pointCount = points.length;
  let indexSum = 0;
  let timeSum = 0;
  for (const point of points) {
    indexSum += point.beatIndex;
    timeSum += point.timeSeconds;
  }
  const indexMean = indexSum / pointCount;
  const timeMean = timeSum / pointCount;
  let covarianceSum = 0;
  let indexVarianceSum = 0;
  for (const point of points) {
    covarianceSum += (point.beatIndex - indexMean) * (point.timeSeconds - timeMean);
    indexVarianceSum += (point.beatIndex - indexMean) ** 2;
  }
  const periodSeconds = indexVarianceSum > 0 ? covarianceSum / indexVarianceSum : 0;
  return { firstBeatSeconds: timeMean - periodSeconds * indexMean, periodSeconds };
}

export interface CountInSearchOptions {
  /** Periodo con el que se programaron los clics. */
  nominalPeriodSeconds: number;
  clickCount: number;
  /**
   * Instante aproximado (línea del micrófono) en que empieza a sonar el primer clic. Con la
   * latencia de salida y entrada, el clic real llega algo después.
   */
  expectedFirstClickSeconds: number;
  /** Margen tras `expectedFirstClickSeconds` donde se busca el primer clic. */
  searchWindowSeconds?: number;
  /** Desviación máxima de un clic respecto a su posición prevista. */
  toleranceSeconds?: number;
  /** Clics que hay que encontrar como mínimo (algún clic puede no detectarse). */
  minimumMatchedClicks?: number;
}

export interface CountInResult {
  beatGrid: BeatGrid;
  matchedClickCount: number;
  /** Instante del último clic esperado según la rejilla. */
  lastClickSeconds: number;
}

/**
 * Busca, entre los golpes detectados, la serie de clics de entrada: la progresión regular con
 * el periodo programado que más golpes explica. Ajusta la rejilla con todos los encontrados.
 */
export function findCountInGrid(onsetTimesSeconds: readonly number[], options: CountInSearchOptions): CountInResult | null {
  const {
    nominalPeriodSeconds,
    clickCount,
    expectedFirstClickSeconds,
    searchWindowSeconds = 0.6,
    toleranceSeconds = 0.04,
    minimumMatchedClicks = clickCount - 2,
  } = options;

  let bestMatches: { beatIndex: number; timeSeconds: number }[] = [];
  let bestTotalErrorSeconds = Infinity;
  const firstClickCandidates = onsetTimesSeconds.filter(
    (onsetTimeSeconds) =>
      onsetTimeSeconds >= expectedFirstClickSeconds - toleranceSeconds &&
      onsetTimeSeconds <= expectedFirstClickSeconds + searchWindowSeconds,
  );

  for (const candidateFirstClick of firstClickCandidates) {
    const candidateMatches = [{ beatIndex: 0, timeSeconds: candidateFirstClick }];
    let totalErrorSeconds = 0;
    for (let clickIndex = 1; clickIndex < clickCount; clickIndex++) {
      const predictedSeconds = candidateFirstClick + clickIndex * nominalPeriodSeconds;
      let nearestOnset: number | null = null;
      for (const onsetTimeSeconds of onsetTimesSeconds) {
        if (nearestOnset === null || Math.abs(onsetTimeSeconds - predictedSeconds) < Math.abs(nearestOnset - predictedSeconds)) {
          nearestOnset = onsetTimeSeconds;
        }
      }
      if (nearestOnset !== null && Math.abs(nearestOnset - predictedSeconds) <= toleranceSeconds) {
        candidateMatches.push({ beatIndex: clickIndex, timeSeconds: nearestOnset });
        totalErrorSeconds += Math.abs(nearestOnset - predictedSeconds);
      }
    }
    const isBetter =
      candidateMatches.length > bestMatches.length ||
      (candidateMatches.length === bestMatches.length && totalErrorSeconds < bestTotalErrorSeconds);
    if (isBetter) {
      bestMatches = candidateMatches;
      bestTotalErrorSeconds = totalErrorSeconds;
    }
  }

  if (bestMatches.length < Math.max(2, minimumMatchedClicks)) return null;
  const beatGrid = fitLine(bestMatches);
  return {
    beatGrid,
    matchedClickCount: bestMatches.length,
    lastClickSeconds: beatTimeSeconds(beatGrid, clickCount - 1),
  };
}

export interface ContinuationOptions {
  /** Índice del primer pulso que hay que dar sin clics (el que sigue al último clic). */
  firstBeatIndex: number;
  beatCount: number;
}

export interface ContinuationScore {
  /** Desfase de cada pulso en ms (positivo = tarde); `null` si no hubo palmada. */
  beatOffsetsMilliseconds: (number | null)[];
  hitBeatCount: number;
  missedBeatCount: number;
  /** Palmadas de más: dos en el mismo pulso. */
  extraClapCount: number;
  /** Media de los desfases: negativo = te adelantas (lo habitual en personas). */
  meanAsynchronyMilliseconds: number;
  /** Desviación típica de los intervalos entre palmadas: lo regular que es tu pulso. */
  intervalVariabilityMilliseconds: number;
  /** Cambio de tempo: positivo = frenas, negativo = aceleras. */
  tempoDriftPercent: number;
  /** 0–100. */
  score: number;
}

/**
 * Asigna cada palmada a un pulso siguiendo sus propios intervalos (no la rejilla), para no
 * perder la cuenta si la persona acelera o frena poco a poco, y mide desfases y deriva.
 */
export function scoreContinuation(
  clapTimesSeconds: readonly number[],
  beatGrid: BeatGrid,
  options: ContinuationOptions,
): ContinuationScore {
  const { firstBeatIndex, beatCount } = options;
  const lastBeatIndex = firstBeatIndex + beatCount - 1;
  const { periodSeconds } = beatGrid;
  const sortedClaps = [...clapTimesSeconds].sort((leftTime, rightTime) => leftTime - rightTime);

  const clapByBeatIndex = new Map<number, number>();
  let extraClapCount = 0;
  let previousAssignment: { beatIndex: number; timeSeconds: number } | null = null;
  for (const clapTimeSeconds of sortedClaps) {
    const beatIndex: number =
      previousAssignment === null
        ? Math.round((clapTimeSeconds - beatGrid.firstBeatSeconds) / periodSeconds)
        : previousAssignment.beatIndex + Math.round((clapTimeSeconds - previousAssignment.timeSeconds) / periodSeconds);
    if (beatIndex < firstBeatIndex || beatIndex > lastBeatIndex) continue;
    const existingClap = clapByBeatIndex.get(beatIndex);
    if (existingClap !== undefined) {
      extraClapCount++;
      continue;
    }
    clapByBeatIndex.set(beatIndex, clapTimeSeconds);
    previousAssignment = { beatIndex, timeSeconds: clapTimeSeconds };
  }

  const beatOffsetsMilliseconds: (number | null)[] = [];
  const hitPoints: { beatIndex: number; timeSeconds: number }[] = [];
  for (let beatIndex = firstBeatIndex; beatIndex <= lastBeatIndex; beatIndex++) {
    const clapTimeSeconds = clapByBeatIndex.get(beatIndex);
    if (clapTimeSeconds === undefined) {
      beatOffsetsMilliseconds.push(null);
      continue;
    }
    beatOffsetsMilliseconds.push((clapTimeSeconds - beatTimeSeconds(beatGrid, beatIndex)) * 1000);
    hitPoints.push({ beatIndex, timeSeconds: clapTimeSeconds });
  }

  const hitOffsets = beatOffsetsMilliseconds.filter((offset): offset is number => offset !== null);
  const meanAsynchronyMilliseconds = hitOffsets.length ? hitOffsets.reduce((offsetSum, offset) => offsetSum + offset, 0) / hitOffsets.length : 0;

  const intervalsMilliseconds: number[] = [];
  for (let pointIndex = 1; pointIndex < hitPoints.length; pointIndex++) {
    const beatDistance = hitPoints[pointIndex]!.beatIndex - hitPoints[pointIndex - 1]!.beatIndex;
    intervalsMilliseconds.push(((hitPoints[pointIndex]!.timeSeconds - hitPoints[pointIndex - 1]!.timeSeconds) * 1000) / beatDistance);
  }
  const intervalMean = intervalsMilliseconds.length
    ? intervalsMilliseconds.reduce((intervalSum, interval) => intervalSum + interval, 0) / intervalsMilliseconds.length
    : 0;
  const intervalVariabilityMilliseconds = intervalsMilliseconds.length
    ? Math.sqrt(intervalsMilliseconds.reduce((squareSum, interval) => squareSum + (interval - intervalMean) ** 2, 0) / intervalsMilliseconds.length)
    : 0;
  const tempoDriftPercent = hitPoints.length >= 2 ? (fitLine(hitPoints).periodSeconds / periodSeconds - 1) * 100 : 0;

  const hitFraction = hitPoints.length / beatCount;
  // Referencias: ±40 ms de variabilidad es un buen aficionado; 3 % de deriva ya se nota.
  const score = Math.round(
    100 *
      hitFraction *
      Math.exp(-intervalVariabilityMilliseconds / 80) *
      Math.exp(-Math.abs(tempoDriftPercent) / 6) *
      Math.exp(-Math.abs(meanAsynchronyMilliseconds) / 250) *
      Math.exp(-extraClapCount / 4),
  );

  return {
    beatOffsetsMilliseconds,
    hitBeatCount: hitPoints.length,
    missedBeatCount: beatCount - hitPoints.length,
    extraClapCount,
    meanAsynchronyMilliseconds,
    intervalVariabilityMilliseconds,
    tempoDriftPercent,
    score,
  };
}

export interface FreeClappingAnalysis {
  beatsPerMinute: number;
  /** Coeficiente de variación de los intervalos (%): bajo = pulso regular. */
  intervalVariationPercent: number;
  clapCount: number;
}

/** Tempo y regularidad de palmadas libres (hacen falta al menos 4). */
export function analyzeFreeClapping(clapTimesSeconds: readonly number[]): FreeClappingAnalysis | null {
  if (clapTimesSeconds.length < 4) return null;
  const tempoEstimate = estimateTempo(clapTimesSeconds, { minimumBeatsPerMinute: 30, maximumBeatsPerMinute: 300 });
  if (!tempoEstimate) return null;
  const beatPeriodSeconds = 60 / tempoEstimate.beatsPerMinute;
  // Solo cuentan los intervalos de un pulso: una pausa o un doble golpe no es irregularidad.
  const singleBeatIntervals: number[] = [];
  for (let clapIndex = 1; clapIndex < clapTimesSeconds.length; clapIndex++) {
    const intervalSeconds = clapTimesSeconds[clapIndex]! - clapTimesSeconds[clapIndex - 1]!;
    if (Math.abs(intervalSeconds / beatPeriodSeconds - 1) <= 0.25) singleBeatIntervals.push(intervalSeconds);
  }
  if (singleBeatIntervals.length < 2) return null;
  const intervalMean = singleBeatIntervals.reduce((intervalSum, interval) => intervalSum + interval, 0) / singleBeatIntervals.length;
  const intervalStandardDeviation = Math.sqrt(
    singleBeatIntervals.reduce((squareSum, interval) => squareSum + (interval - intervalMean) ** 2, 0) / singleBeatIntervals.length,
  );
  return {
    beatsPerMinute: 60 / intervalMean,
    intervalVariationPercent: (intervalStandardDeviation / intervalMean) * 100,
    clapCount: clapTimesSeconds.length,
  };
}
