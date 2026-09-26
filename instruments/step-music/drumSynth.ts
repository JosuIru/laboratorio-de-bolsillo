import { createBiquadState, designBiquad, processBiquadBlock } from '@/processing/dsp/biquad';
import { generateNoise, generateTone } from '@/processing/dsp/signalGenerator';

/**
 * Sonidos del ritmo, sintetizados (sin muestras grabadas): bombo con barrido de tono, caja con
 * ruido y cuerpo, charles con ruido agudo, bajo y arpegio con onda triangular y caída.
 * Devuelven muestras en [−1, 1] listas para copiar a un AudioBuffer.
 */

function applyExponentialDecay(
  samples: Float32Array,
  sampleRateHz: number,
  decaySeconds: number,
  attackSeconds = 0.002,
) {
  const attackSamples = Math.max(1, Math.round(attackSeconds * sampleRateHz));
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const attackGain = sampleIndex < attackSamples ? sampleIndex / attackSamples : 1;
    samples[sampleIndex]! *= attackGain * Math.exp(-sampleIndex / sampleRateHz / decaySeconds);
  }
  return samples;
}

/** Bombo: senoidal que cae de 150 a 45 Hz en unos milisegundos. */
export function synthesizeKick(sampleRateHz: number): Float32Array {
  const kickSamples = new Float32Array(Math.round(0.35 * sampleRateHz));
  let phaseCycles = 0;
  for (let sampleIndex = 0; sampleIndex < kickSamples.length; sampleIndex++) {
    const elapsedSeconds = sampleIndex / sampleRateHz;
    const frequencyHz = 45 + 105 * Math.exp(-elapsedSeconds / 0.03);
    phaseCycles += frequencyHz / sampleRateHz;
    kickSamples[sampleIndex] = Math.sin(2 * Math.PI * phaseCycles);
  }
  return applyExponentialDecay(kickSamples, sampleRateHz, 0.12, 0.001);
}

/** Caja: ruido filtrado más un cuerpo de 190 Hz. */
export function synthesizeSnare(sampleRateHz: number): Float32Array {
  const durationSeconds = 0.22;
  const noiseSamples = generateNoise({ sampleRateHz, durationSeconds, amplitude: 0.8, seed: 11 });
  const bandPass = designBiquad('band-pass', 2500, sampleRateHz, 0.8);
  processBiquadBlock(bandPass, createBiquadState(), noiseSamples, noiseSamples);
  const bodySamples = generateTone({ frequencyHz: 190, sampleRateHz, durationSeconds, amplitude: 0.5 });
  applyExponentialDecay(bodySamples, sampleRateHz, 0.04);
  applyExponentialDecay(noiseSamples, sampleRateHz, 0.07);
  return noiseSamples.map((noiseValue, sampleIndex) => noiseValue + bodySamples[sampleIndex]!);
}

/** Charles cerrado: ruido muy agudo y muy corto. */
export function synthesizeHat(sampleRateHz: number): Float32Array {
  const hatSamples = generateNoise({ sampleRateHz, durationSeconds: 0.06, amplitude: 0.5, seed: 23 });
  const highPass = designBiquad('high-pass', Math.min(8000, sampleRateHz * 0.4), sampleRateHz);
  processBiquadBlock(highPass, createBiquadState(), hatSamples, hatSamples);
  return applyExponentialDecay(hatSamples, sampleRateHz, 0.015, 0.0005);
}

/** Nota tonal con caída (bajo o arpegio). */
export function synthesizeNote(sampleRateHz: number, midiNote: number, durationSeconds: number, decaySeconds: number) {
  const noteSamples = generateTone({
    frequencyHz: 440 * 2 ** ((midiNote - 69) / 12),
    sampleRateHz,
    durationSeconds,
    amplitude: 0.6,
    waveform: 'triangle',
  });
  return applyExponentialDecay(noteSamples, sampleRateHz, decaySeconds, 0.004);
}
