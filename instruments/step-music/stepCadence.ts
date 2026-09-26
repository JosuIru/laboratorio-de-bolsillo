import { estimatePitchMcLeod } from '@/processing/dsp/mcleodPitch';
import { resampleUniformly } from '@/processing/signal/resampling';

/**
 * Cadencia de pasos a partir del acelerómetro. Andar o correr repite el mismo golpe en cada
 * paso, así que el periodo de los pasos se encuentra igual que el de una nota: con la función de
 * autocorrelación normalizada de McLeod, que además prefiere el periodo más corto (un paso) al de
 * la zancada (dos pasos).
 */

/** Frecuencia a la que se remuestrea el módulo de la aceleración. */
export const cadenceSampleRateHz = 50;
/** De 48 pasos/min (paseo muy lento) a 240 (sprint). */
const minimumStepsPerSecond = 0.8;
const maximumStepsPerSecond = 4;
/** Por debajo de este movimiento (RMS del módulo sin la gravedad, m/s²) el móvil está quieto. */
const minimumMovementRms = 0.4;
/** Claridad mínima de la periodicidad: por debajo, no es un paso regular. */
export const minimumCadenceClarity = 0.6;

export interface CadenceEstimate {
  stepsPerMinute: number;
  clarity: number;
}

export function estimateCadence(
  timestampsSeconds: ArrayLike<number>,
  accelerationMagnitudes: ArrayLike<number>,
): CadenceEstimate | null {
  if (timestampsSeconds.length < 2) return null;
  const { values: uniformMagnitudes } = resampleUniformly(
    timestampsSeconds,
    accelerationMagnitudes,
    cadenceSampleRateHz,
  );
  if (uniformMagnitudes.length < cadenceSampleRateHz * 2) return null;
  let magnitudeSum = 0;
  for (const magnitude of uniformMagnitudes) magnitudeSum += magnitude;
  const meanMagnitude = magnitudeSum / uniformMagnitudes.length;
  const dynamicMagnitudes = uniformMagnitudes.map((magnitude) => magnitude - meanMagnitude);

  const periodicityEstimate = estimatePitchMcLeod(dynamicMagnitudes, {
    sampleRateHz: cadenceSampleRateHz,
    minimumFrequencyHz: minimumStepsPerSecond,
    maximumFrequencyHz: maximumStepsPerSecond,
    minimumRootMeanSquare: minimumMovementRms,
    peakThresholdFraction: 0.85,
  });
  if (!periodicityEstimate || periodicityEstimate.clarity < minimumCadenceClarity) return null;
  return { stepsPerMinute: periodicityEstimate.frequencyHz * 60, clarity: periodicityEstimate.clarity };
}

/** Tempo musical cómodo para una cadencia: se usa la misma o la mitad para que no pase de 180. */
export const minimumMusicBpm = 70;
export const maximumMusicBpm = 180;

export function cadenceToMusicBpm(stepsPerMinute: number): number {
  let musicBpm = stepsPerMinute;
  while (musicBpm > maximumMusicBpm) musicBpm /= 2;
  while (musicBpm < minimumMusicBpm) musicBpm *= 2;
  return musicBpm;
}

/** Nivel de energía de la música (0–3) según la cadencia: pasear, andar rápido, trotar, correr. */
export function energyForCadence(stepsPerMinute: number): 0 | 1 | 2 | 3 {
  if (stepsPerMinute < 100) return 0;
  if (stepsPerMinute < 125) return 1;
  if (stepsPerMinute < 155) return 2;
  return 3;
}

/** Diferencia con la cadencia objetivo: dentro de ±3 % se va al ritmo. */
export function compareWithTarget(
  stepsPerMinute: number,
  targetStepsPerMinute: number,
): 'slower' | 'on-pace' | 'faster' {
  const relativeDifference = (stepsPerMinute - targetStepsPerMinute) / targetStepsPerMinute;
  if (relativeDifference < -0.03) return 'slower';
  if (relativeDifference > 0.03) return 'faster';
  return 'on-pace';
}
