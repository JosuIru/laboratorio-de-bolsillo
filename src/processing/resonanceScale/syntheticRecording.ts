/**
 * Grabaciones sintéticas del acelerómetro con pulsos de vibración, para los tests.
 * Imitan lo que llega de Android: marcas con jitter, huecos, gravedad y ruido.
 */

import { createSeededRandom } from '@/processing/dsp/signalGenerator';

import type { AccelerationRecording } from './pulseResponse';

export interface SyntheticPulseRecordingOptions {
  sampleRateHz: number;
  motorFrequencyHz: number;
  /** Amplitud de pico de la aceleración vibratoria en el eje dominante (m/s²). */
  vibrationAmplitude: number;
  initialDelaySeconds: number;
  pulseCount: number;
  pulseOnSeconds: number;
  pulseOffSeconds: number;
  tailSeconds: number;
  noiseAmplitude: number;
  /** Variación aleatoria de la amplitud de cada pulso (fracción). */
  pulseAmplitudeJitter: number;
  /** Fracción de muestras que se pierden. */
  dropFraction: number;
  seed: number;
  /** Tiempo de arranque del motor (la amplitud sube linealmente). */
  spinUpSeconds: number;
}

export const defaultSyntheticOptions: SyntheticPulseRecordingOptions = {
  sampleRateHz: 420,
  motorFrequencyHz: 170,
  vibrationAmplitude: 2,
  initialDelaySeconds: 1.5,
  pulseCount: 6,
  pulseOnSeconds: 0.5,
  pulseOffSeconds: 0.4,
  tailSeconds: 0.3,
  noiseAmplitude: 0.02,
  pulseAmplitudeJitter: 0,
  dropFraction: 0.05,
  seed: 7,
  spinUpSeconds: 0.06,
};

export interface SyntheticPulseRecording extends AccelerationRecording {
  timestampsSeconds: number[];
  x: number[];
  y: number[];
  z: number[];
  pulseAmplitudes: number[];
}

export function createSyntheticPulseRecording(
  options: Partial<SyntheticPulseRecordingOptions> = {},
): SyntheticPulseRecording {
  const settings = { ...defaultSyntheticOptions, ...options };
  const random = createSeededRandom(settings.seed);
  const pulseAmplitudes = Array.from(
    { length: settings.pulseCount },
    () => settings.vibrationAmplitude * (1 + settings.pulseAmplitudeJitter * (2 * random() - 1)),
  );
  const totalSeconds =
    settings.initialDelaySeconds +
    settings.pulseCount * (settings.pulseOnSeconds + settings.pulseOffSeconds) +
    settings.tailSeconds;
  const timestampsSeconds: number[] = [];
  const xValues: number[] = [];
  const yValues: number[] = [];
  const zValues: number[] = [];
  const bootOffsetSeconds = 12345.678;
  const nominalIntervalSeconds = 1 / settings.sampleRateHz;

  for (let sampleIndex = 0; sampleIndex * nominalIntervalSeconds < totalSeconds; sampleIndex++) {
    if (random() < settings.dropFraction) continue;
    const elapsedSeconds = sampleIndex * nominalIntervalSeconds + (random() - 0.5) * 0.2 * nominalIntervalSeconds;
    const pulseTimeSeconds = elapsedSeconds - settings.initialDelaySeconds;
    const pulsePeriodSeconds = settings.pulseOnSeconds + settings.pulseOffSeconds;
    const pulseIndex = Math.floor(pulseTimeSeconds / pulsePeriodSeconds);
    const timeInPulseSeconds = pulseTimeSeconds - pulseIndex * pulsePeriodSeconds;
    let vibrationEnvelope = 0;
    if (pulseTimeSeconds >= 0 && pulseIndex < settings.pulseCount && timeInPulseSeconds < settings.pulseOnSeconds) {
      vibrationEnvelope = pulseAmplitudes[pulseIndex]! * Math.min(1, timeInPulseSeconds / settings.spinUpSeconds);
    }
    const motorPhase = 2 * Math.PI * settings.motorFrequencyHz * elapsedSeconds;
    const noise = () => settings.noiseAmplitude * (2 * random() - 1);
    timestampsSeconds.push(bootOffsetSeconds + elapsedSeconds);
    xValues.push(0.1 + vibrationEnvelope * Math.sin(motorPhase) + noise());
    yValues.push(-0.2 + 0.5 * vibrationEnvelope * Math.cos(motorPhase) + noise());
    zValues.push(9.81 + 0.2 * vibrationEnvelope * Math.sin(motorPhase + 1) + noise());
  }
  return { timestampsSeconds, x: xValues, y: yValues, z: zValues, pulseAmplitudes };
}

/** RMS vibratorio esperado con el motor en marcha: √(Σ Aᵢ²/2) de los tres ejes. */
export function expectedVibrationRms(peakAmplitude: number): number {
  return peakAmplitude * Math.sqrt((1 + 0.25 + 0.04) / 2);
}
