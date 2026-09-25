/**
 * Grabaciones sintéticas para probar el localizador sin móviles: lo que oiría un micrófono con su
 * propio reloj (desfasado y con deriva) cuando suenan los dos chirridos de referencia y una
 * palmada, con rebotes y ruido. Los instantes son continuos, así que las llegadas caen entre
 * muestras como en la realidad.
 */

import { createSeededRandom } from '@/processing/dsp/signalGenerator';
import { evaluateSonarChirpAt } from '@/processing/sonar/chirp';

import { referenceChirpSeparationSeconds, referenceChirpSpecification } from './referenceSignal';

export interface SyntheticClap {
  frequenciesHz: number[];
  phasesRadians: number[];
  amplitudes: number[];
  decaySeconds: number;
}

/** Palmada: ráfaga de parciales entre 0,8 y 5 kHz que sube en ~0,2 ms y cae en ~4 ms. */
export function createSyntheticClap(seed: number): SyntheticClap {
  const nextRandom = createSeededRandom(seed);
  const partialCount = 12;
  return {
    frequenciesHz: Array.from({ length: partialCount }, () => 800 + 4200 * nextRandom()),
    phasesRadians: Array.from({ length: partialCount }, () => 2 * Math.PI * nextRandom()),
    amplitudes: Array.from({ length: partialCount }, () => (0.5 + nextRandom()) / partialCount),
    decaySeconds: 0.004,
  };
}

export function evaluateClapAt(syntheticClap: SyntheticClap, elapsedSeconds: number): number {
  if (elapsedSeconds < 0 || elapsedSeconds > 0.08) return 0;
  const envelope = Math.exp(-elapsedSeconds / syntheticClap.decaySeconds) * (1 - Math.exp(-elapsedSeconds / 0.0002));
  let clapValue = 0;
  for (let partialIndex = 0; partialIndex < syntheticClap.frequenciesHz.length; partialIndex++) {
    clapValue +=
      syntheticClap.amplitudes[partialIndex]! *
      Math.sin(2 * Math.PI * syntheticClap.frequenciesHz[partialIndex]! * elapsedSeconds + syntheticClap.phasesRadians[partialIndex]!);
  }
  return 2.5 * envelope * clapValue;
}

export interface SyntheticArrival {
  /** Instante de llegada en el tiempo «verdadero» (s). */
  arrivalSeconds: number;
  amplitude: number;
}

export interface SyntheticRecordingOptions {
  sampleRateHz: number;
  durationSeconds: number;
  /** Instante verdadero en que empieza a grabar este móvil. */
  recordingStartSeconds: number;
  /** Deriva del reloj del micrófono: + significa que toma más muestras por segundo de las nominales. */
  clockDriftPartsPerMillion: number;
  /** Llegadas del primer chirrido (directo y rebotes); el segundo llega `referenceChirpSeparationSeconds` después. */
  chirpArrivals: readonly SyntheticArrival[];
  clapArrivals: readonly SyntheticArrival[];
  syntheticClap: SyntheticClap;
  noiseAmplitude: number;
  seed: number;
}

export function synthesizeRecording(options: SyntheticRecordingOptions): Float32Array {
  const {
    sampleRateHz,
    durationSeconds,
    recordingStartSeconds,
    clockDriftPartsPerMillion,
    chirpArrivals,
    clapArrivals,
    syntheticClap,
    noiseAmplitude,
    seed,
  } = options;
  const nextRandom = createSeededRandom(seed);
  const actualSampleRateHz = sampleRateHz * (1 + clockDriftPartsPerMillion * 1e-6);
  const recording = new Float32Array(Math.round(durationSeconds * sampleRateHz));
  for (let sampleIndex = 0; sampleIndex < recording.length; sampleIndex++) {
    const trueTimeSeconds = recordingStartSeconds + sampleIndex / actualSampleRateHz;
    let sampleValue = noiseAmplitude * (nextRandom() + nextRandom() + nextRandom() - 1.5) * 2;
    for (const chirpArrival of chirpArrivals) {
      sampleValue +=
        chirpArrival.amplitude *
        (evaluateSonarChirpAt(referenceChirpSpecification, trueTimeSeconds - chirpArrival.arrivalSeconds) +
          evaluateSonarChirpAt(
            referenceChirpSpecification,
            trueTimeSeconds - chirpArrival.arrivalSeconds - referenceChirpSeparationSeconds,
          ));
    }
    for (const clapArrival of clapArrivals) {
      sampleValue += clapArrival.amplitude * evaluateClapAt(syntheticClap, trueTimeSeconds - clapArrival.arrivalSeconds);
    }
    recording[sampleIndex] = sampleValue;
  }
  return recording;
}
