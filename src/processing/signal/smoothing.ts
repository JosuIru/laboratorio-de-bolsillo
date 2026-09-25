/**
 * Filtro paso bajo exponencial: `salida = salida + alpha · (entrada − salida)`.
 * `alpha` en (0, 1]: cuanto más pequeño, más suave y más lento.
 */
export function createExponentialSmoother(smoothingFactor: number) {
  if (!(smoothingFactor > 0 && smoothingFactor <= 1)) {
    throw new RangeError('smoothingFactor debe estar en (0, 1]');
  }
  let smoothedValue: number | null = null;
  return {
    push(inputValue: number): number {
      smoothedValue = smoothedValue === null ? inputValue : smoothedValue + smoothingFactor * (inputValue - smoothedValue);
      return smoothedValue;
    },
    reset(): void {
      smoothedValue = null;
    },
  };
}

/** Factor de suavizado equivalente a un filtro RC con constante de tiempo `timeConstantSeconds`. */
export function smoothingFactorForTimeConstant(timeConstantSeconds: number, sampleRateHz: number): number {
  const samplePeriodSeconds = 1 / sampleRateHz;
  return samplePeriodSeconds / (timeConstantSeconds + samplePeriodSeconds);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let valueSum = 0;
  for (const value of values) valueSum += value;
  return valueSum / values.length;
}
