/**
 * Los sensores de Android no entregan muestras a intervalos exactos (hay jitter y huecos),
 * pero la FFT necesita muestreo uniforme. Estas funciones estiman la frecuencia real y
 * remuestrean por interpolación lineal.
 */

/**
 * Frecuencia de muestreo robusta: la mediana de los intervalos descarta los huecos y, después,
 * la media de los intervalos cercanos a la mediana corrige el sesgo del jitter.
 */
export function estimateSampleRateHz(timestampsSeconds: ArrayLike<number>): number | null {
  if (timestampsSeconds.length < 2) return null;
  const intervalsSeconds: number[] = [];
  for (let sampleIndex = 1; sampleIndex < timestampsSeconds.length; sampleIndex++) {
    const intervalSeconds = timestampsSeconds[sampleIndex]! - timestampsSeconds[sampleIndex - 1]!;
    if (intervalSeconds > 0) intervalsSeconds.push(intervalSeconds);
  }
  if (intervalsSeconds.length === 0) return null;
  intervalsSeconds.sort((leftInterval, rightInterval) => leftInterval - rightInterval);
  const middleIndex = Math.floor(intervalsSeconds.length / 2);
  const medianIntervalSeconds =
    intervalsSeconds.length % 2 === 1
      ? intervalsSeconds[middleIndex]!
      : (intervalsSeconds[middleIndex - 1]! + intervalsSeconds[middleIndex]!) / 2;
  let inlierSum = 0;
  let inlierCount = 0;
  for (const intervalSeconds of intervalsSeconds) {
    if (intervalSeconds > 0.5 * medianIntervalSeconds && intervalSeconds < 1.5 * medianIntervalSeconds) {
      inlierSum += intervalSeconds;
      inlierCount++;
    }
  }
  return inlierCount > 0 ? inlierCount / inlierSum : 1 / medianIntervalSeconds;
}

/**
 * Remuestrea a `targetRateHz` entre la primera y la última marca de tiempo.
 * Las marcas deben ser crecientes; las repetidas se ignoran.
 */
export function resampleUniformly(
  timestampsSeconds: ArrayLike<number>,
  sampleValues: ArrayLike<number>,
  targetRateHz: number,
): { values: Float64Array; startTimeSeconds: number } {
  if (timestampsSeconds.length !== sampleValues.length) {
    throw new RangeError('Las marcas de tiempo y los valores deben tener la misma longitud');
  }
  if (!(targetRateHz > 0)) throw new RangeError('La frecuencia objetivo debe ser positiva');
  if (timestampsSeconds.length === 0) return { values: new Float64Array(0), startTimeSeconds: 0 };

  const startTimeSeconds = timestampsSeconds[0]!;
  const durationSeconds = timestampsSeconds[timestampsSeconds.length - 1]! - startTimeSeconds;
  const outputCount = Math.floor(durationSeconds * targetRateHz + 1e-9) + 1;
  const resampledValues = new Float64Array(outputCount);

  let sourceIndex = 0;
  for (let outputIndex = 0; outputIndex < outputCount; outputIndex++) {
    const targetTimeSeconds = startTimeSeconds + outputIndex / targetRateHz;
    while (sourceIndex < timestampsSeconds.length - 2 && timestampsSeconds[sourceIndex + 1]! <= targetTimeSeconds) {
      sourceIndex++;
    }
    const leftTime = timestampsSeconds[sourceIndex]!;
    const rightTime = timestampsSeconds[Math.min(sourceIndex + 1, timestampsSeconds.length - 1)]!;
    const leftValue = sampleValues[sourceIndex]!;
    const rightValue = sampleValues[Math.min(sourceIndex + 1, sampleValues.length - 1)]!;
    const interpolationFraction =
      rightTime > leftTime ? Math.min(1, Math.max(0, (targetTimeSeconds - leftTime) / (rightTime - leftTime))) : 0;
    resampledValues[outputIndex] = leftValue + interpolationFraction * (rightValue - leftValue);
  }
  return { values: resampledValues, startTimeSeconds };
}
