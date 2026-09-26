import { applyFadesInPlace, generateTone } from '@/processing/dsp/signalGenerator';

/** Tres pitidos agudos y un silencio: el patrón se repite en bucle hasta que se para. */
const beepFrequenciesHz = [1319, 1319, 1760] as const;
const beepDurationSeconds = 0.15;
const gapBetweenBeepsSeconds = 0.1;
export const alarmPatternDurationSeconds = 1.6;
const beepFadeSeconds = 0.005;
const beepAmplitude = 0.8;

/** Vibración que acompaña a la alarma: [espera, vibra, espera, vibra…] en ms, repetida. */
export const alarmVibrationPattern = [0, 600, 400, 600, 1000];

/** Muestras de un periodo del patrón (pitidos + silencio), listas para reproducir en bucle. */
export function generateAlarmPattern(sampleRateHz: number): Float32Array<ArrayBuffer> {
  const patternSamples = new Float32Array(Math.round(alarmPatternDurationSeconds * sampleRateHz));
  const fadeSampleCount = Math.round(beepFadeSeconds * sampleRateHz);
  beepFrequenciesHz.forEach((frequencyHz, beepIndex) => {
    const beepSamples = applyFadesInPlace(
      generateTone({ frequencyHz, sampleRateHz, durationSeconds: beepDurationSeconds, amplitude: beepAmplitude }),
      fadeSampleCount,
    );
    const beepOffset = Math.round(beepIndex * (beepDurationSeconds + gapBetweenBeepsSeconds) * sampleRateHz);
    patternSamples.set(beepSamples.subarray(0, patternSamples.length - beepOffset), beepOffset);
  });
  return patternSamples;
}
