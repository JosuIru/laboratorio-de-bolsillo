/**
 * Estadística de recuento: los sucesos llegan al azar e independientes, así que su número en un
 * intervalo sigue una distribución de Poisson. Con N sucesos, la incertidumbre típica es √N
 * (±30 % con 10 sucesos, ±10 % con 100). Con pocos sucesos, √N engaña (con 0 daría 0 ± 0), así
 * que también se da el intervalo exacto de Garwood.
 *
 * Módulo puro: sin React ni React Native.
 */

/** Nivel de confianza de ±1 σ en una normal. */
export const oneSigmaConfidence = 0.6827;

/** P(X ≤ count) para X ~ Poisson(expectedCount), sumando términos en escala logarítmica. */
export function poissonCumulativeProbability(count: number, expectedCount: number): number {
  if (count < 0) return 0;
  if (expectedCount <= 0) return 1;
  let logTerm = -expectedCount;
  let cumulativeProbability = Math.exp(logTerm);
  for (let term = 1; term <= count; term++) {
    logTerm += Math.log(expectedCount) - Math.log(term);
    cumulativeProbability += Math.exp(logTerm);
  }
  return Math.min(1, cumulativeProbability);
}

/** Busca por bisección el λ en [low, high] donde `probabilityFor(λ)` (decreciente) vale `target`. */
function solveDecreasingProbability(
  probabilityFor: (expectedCount: number) => number,
  target: number,
  lowExpectedCount: number,
  highExpectedCount: number,
): number {
  let lowBound = lowExpectedCount;
  let highBound = highExpectedCount;
  for (let iteration = 0; iteration < 100; iteration++) {
    const middle = (lowBound + highBound) / 2;
    if (probabilityFor(middle) > target) lowBound = middle;
    else highBound = middle;
  }
  return (lowBound + highBound) / 2;
}

export interface PoissonInterval {
  lower: number;
  upper: number;
}

/**
 * Intervalo de confianza exacto (Garwood) del número esperado de sucesos tras contar `count`.
 * Con 0 sucesos, el límite inferior es 0 y el superior 1,84 (al 68 %).
 */
export function poissonConfidenceInterval(count: number, confidenceLevel = oneSigmaConfidence): PoissonInterval {
  const tailProbability = (1 - confidenceLevel) / 2;
  const searchCeiling = count + 20 * Math.sqrt(count + 1) + 20;
  // Superior: el λ con P(X ≤ count) = cola.
  const upper = solveDecreasingProbability(
    (expectedCount) => poissonCumulativeProbability(count, expectedCount),
    tailProbability,
    0,
    searchCeiling,
  );
  if (count === 0) return { lower: 0, upper };
  // Inferior: el λ con P(X ≥ count) = cola, es decir, P(X ≤ count − 1) = 1 − cola.
  const lower = solveDecreasingProbability(
    (expectedCount) => poissonCumulativeProbability(count - 1, expectedCount),
    1 - tailProbability,
    0,
    searchCeiling,
  );
  return { lower, upper };
}

export interface CountingRate {
  count: number;
  durationMinutes: number;
  ratePerMinute: number;
  /** √N / T: la incertidumbre típica de Poisson. */
  standardUncertaintyPerMinute: number;
  /** Intervalo exacto al 68 %. */
  lowerPerMinute: number;
  upperPerMinute: number;
}

export function countingRate(count: number, durationMinutes: number): CountingRate | null {
  if (!(durationMinutes > 0)) return null;
  const interval = poissonConfidenceInterval(count);
  return {
    count,
    durationMinutes,
    ratePerMinute: count / durationMinutes,
    standardUncertaintyPerMinute: Math.sqrt(count) / durationMinutes,
    lowerPerMinute: interval.lower / durationMinutes,
    upperPerMinute: interval.upper / durationMinutes,
  };
}

/** Incertidumbre relativa de un recuento (1/√N); `Infinity` sin sucesos. */
export function relativeCountingUncertainty(count: number): number {
  return count > 0 ? 1 / Math.sqrt(count) : Infinity;
}

/** Sucesos necesarios para una incertidumbre relativa dada (10 % → 100 sucesos). */
export function countsForRelativeUncertainty(relativeUncertainty: number): number {
  return Math.ceil(1 / relativeUncertainty ** 2);
}
