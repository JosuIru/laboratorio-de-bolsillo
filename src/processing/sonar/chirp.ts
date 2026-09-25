/**
 * Pulsos del sonar: barridos lineales (chirps) cortos en la banda ultrasónica, con rampas de
 * coseno para que el altavoz no haga clic, y elección de la banda según la frecuencia de muestreo.
 */

export interface SonarChirpSpecification {
  startFrequencyHz: number;
  endFrequencyHz: number;
  durationSeconds: number;
  /** Fracción de la duración que ocupa cada rampa (entrada y salida), en (0, 0,5]. */
  taperFraction?: number;
  amplitude?: number;
}

export const defaultTaperFraction = 0.5;

/**
 * Valor del chirp en un instante continuo (0 fuera del pulso). Sirve para generar el pulso y,
 * en los tests, para simular ecos con retardos que no son un número entero de muestras.
 */
export function evaluateSonarChirpAt(specification: SonarChirpSpecification, elapsedSeconds: number): number {
  'worklet';
  const {
    startFrequencyHz,
    endFrequencyHz,
    durationSeconds,
    taperFraction = defaultTaperFraction,
    amplitude = 1,
  } = specification;
  if (elapsedSeconds < 0 || elapsedSeconds > durationSeconds) return 0;
  const sweepRateHzPerSecond = (endFrequencyHz - startFrequencyHz) / durationSeconds;
  const phaseRadians =
    2 * Math.PI * (startFrequencyHz * elapsedSeconds + 0.5 * sweepRateHzPerSecond * elapsedSeconds * elapsedSeconds);
  // Ventana de Tukey: rampas de coseno elevado al principio y al final, meseta en medio.
  const taperSeconds = Math.max(1e-9, Math.min(0.5, taperFraction) * durationSeconds);
  const distanceToEdgeSeconds = Math.min(elapsedSeconds, durationSeconds - elapsedSeconds);
  const taperGain =
    distanceToEdgeSeconds >= taperSeconds ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * distanceToEdgeSeconds) / taperSeconds);
  return amplitude * taperGain * Math.sin(phaseRadians);
}

export function generateSonarChirp(specification: SonarChirpSpecification, sampleRateHz: number): Float32Array {
  const nyquistHz = sampleRateHz / 2;
  if (!(specification.startFrequencyHz > 0 && specification.endFrequencyHz <= nyquistHz)) {
    throw new RangeError(`La banda del chirp debe estar en (0, ${nyquistHz}] Hz`);
  }
  if (!(specification.durationSeconds > 0)) throw new RangeError('La duración del chirp debe ser positiva');
  const chirpSamples = new Float32Array(Math.round(specification.durationSeconds * sampleRateHz));
  for (let sampleIndex = 0; sampleIndex < chirpSamples.length; sampleIndex++) {
    chirpSamples[sampleIndex] = evaluateSonarChirpAt(specification, sampleIndex / sampleRateHz);
  }
  return chirpSamples;
}

/** Un periodo de emisión: el chirp al principio y silencio hasta completar `periodSamples`. */
export function createPulsePeriod(chirpSamples: Float32Array, periodSamples: number): Float32Array {
  if (periodSamples < chirpSamples.length) throw new RangeError('El periodo debe ser más largo que el chirp');
  const periodBuffer = new Float32Array(periodSamples);
  periodBuffer.set(chirpSamples, 0);
  return periodBuffer;
}

export interface SonarBand {
  lowFrequencyHz: number;
  highFrequencyHz: number;
  /** `true` si la frecuencia de muestreo obliga a bajar la banda pedida. */
  isReduced: boolean;
  /** `true` si la banda resultante empieza por debajo de ~17 kHz: mucha gente la oirá. */
  isLikelyAudible: boolean;
}

/** Margen bajo Nyquist: el filtro antialiasing del micrófono ya atenúa mucho ahí. */
const nyquistGuardHz = 1000;
const likelyAudibleBelowHz = 17000;
/** Muestreo mínimo con el que se intenta usar la banda ultrasónica tal cual. */
export const minimumUltrasonicSampleRateHz = 44100;

/**
 * Banda del sonar para una frecuencia de muestreo. Se mantiene el ancho de banda pedido (de él
 * depende la resolución en distancia) y, si no cabe bajo Nyquist, se desplaza hacia abajo.
 */
export function chooseSonarBand(
  sampleRateHz: number,
  preferredLowFrequencyHz = 18000,
  preferredHighFrequencyHz = 22000,
): SonarBand {
  const bandwidthHz = preferredHighFrequencyHz - preferredLowFrequencyHz;
  if (!(bandwidthHz > 0)) throw new RangeError('La banda debe tener anchura positiva');
  const maximumHighFrequencyHz = sampleRateHz / 2 - nyquistGuardHz;
  const highFrequencyHz = Math.min(preferredHighFrequencyHz, maximumHighFrequencyHz);
  const lowFrequencyHz = Math.max(500, highFrequencyHz - bandwidthHz);
  return {
    lowFrequencyHz,
    highFrequencyHz,
    isReduced: highFrequencyHz < preferredHighFrequencyHz,
    isLikelyAudible: lowFrequencyHz < likelyAudibleBelowHz,
  };
}
