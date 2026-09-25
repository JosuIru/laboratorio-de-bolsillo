/**
 * Utilidades para simular canales en los tests del módem (no se usan en la app).
 * Generador pseudoaleatorio con semilla para que los tests sean reproducibles.
 */

export function createSeededRandom(seed: number): () => number {
  let generatorState = seed >>> 0 || 1;
  return () => {
    generatorState ^= generatorState << 13;
    generatorState ^= generatorState >>> 17;
    generatorState ^= generatorState << 5;
    generatorState >>>= 0;
    return generatorState / 4294967296;
  };
}

/** Número con distribución normal (Box-Muller). */
export function gaussianSample(random: () => number): number {
  const firstUniform = Math.max(random(), 1e-12);
  const secondUniform = random();
  return Math.sqrt(-2 * Math.log(firstUniform)) * Math.cos(2 * Math.PI * secondUniform);
}

/**
 * Remuestrea por interpolación lineal: `rateRatio` = frecuencia del receptor / emisor. Un valor
 * como 1,0002 simula dos relojes que difieren en 200 ppm.
 */
export function resampleLinear(samples: Float32Array, rateRatio: number): Float32Array {
  const outputLength = Math.floor(samples.length * rateRatio);
  const resampled = new Float32Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
    const sourcePosition = outputIndex / rateRatio;
    const lowerIndex = Math.floor(sourcePosition);
    const fraction = sourcePosition - lowerIndex;
    resampled[outputIndex] =
      (samples[lowerIndex] ?? 0) * (1 - fraction) + (samples[Math.min(lowerIndex + 1, samples.length - 1)] ?? 0) * fraction;
  }
  return resampled;
}
