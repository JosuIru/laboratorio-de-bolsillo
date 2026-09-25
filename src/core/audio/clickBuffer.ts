import type { AudioBuffer, AudioContext } from 'react-native-audio-api';

import { applyFadesInPlace, generateTone } from '@/processing/dsp/signalGenerator';

const accentFrequencyHz = 1500;
const regularFrequencyHz = 1000;
const clickDurationSeconds = 0.03;
const clickFadeSeconds = 0.002;

/**
 * Clic corto de metrónomo con rampas para que no suene a chasquido digital. El acento (primer
 * pulso del compás) es más agudo.
 */
export function createClickBuffer(audioContext: AudioContext, isAccent: boolean, amplitude: number): AudioBuffer {
  const sampleRateHz = audioContext.sampleRate;
  const clickSamples = generateTone({
    frequencyHz: isAccent ? accentFrequencyHz : regularFrequencyHz,
    sampleRateHz,
    durationSeconds: clickDurationSeconds,
    amplitude,
  });
  applyFadesInPlace(clickSamples, Math.round(clickFadeSeconds * sampleRateHz));
  const clickBuffer = audioContext.createBuffer(1, clickSamples.length, sampleRateHz);
  // copyToChannel exige un Float32Array respaldado por un ArrayBuffer normal.
  clickBuffer.copyToChannel(new Float32Array(clickSamples), 0);
  return clickBuffer;
}
