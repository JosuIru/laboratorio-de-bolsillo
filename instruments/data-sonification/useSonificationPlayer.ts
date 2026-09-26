import { type RefObject, useEffect } from 'react';
import { type AudioBuffer, AudioContext } from 'react-native-audio-api';

import { useIsAppActive } from '@/core/useIsAppActive';
import { generateTone } from '@/processing/dsp/signalGenerator';

import {
  midiNoteToFrequencyHz,
  normalizedValueToMidiNote,
  normalizedValueToThereminFrequencyHz,
  type SonificationMode,
  type SonificationScaleId,
} from './sonification';
import type { SourceReading } from './useSourceValue';

/** Notas por segundo en modo melodía. */
const melodyNoteIntervalMilliseconds = 200;
const pluckSeconds = 0.6;
/** Constante de la caída exponencial de cada nota (s): suena a cuerda pulsada. */
const pluckDecaySeconds = 0.18;
const pluckAmplitude = 0.35;
const thereminVolume = 0.25;
const thereminUpdateMilliseconds = 40;
/** Suavizado del cambio de frecuencia del theremin (s): glissando sin escalones. */
const thereminGlideSeconds = 0.05;

function createPluckBuffer(audioContext: AudioContext, frequencyHz: number): AudioBuffer {
  const sampleRateHz = audioContext.sampleRate;
  const pluckSamples = generateTone({
    frequencyHz,
    sampleRateHz,
    durationSeconds: pluckSeconds,
    amplitude: pluckAmplitude,
    waveform: 'triangle',
  });
  const attackSamples = Math.round(0.004 * sampleRateHz);
  for (let sampleIndex = 0; sampleIndex < pluckSamples.length; sampleIndex++) {
    const attackGain = sampleIndex < attackSamples ? sampleIndex / attackSamples : 1;
    pluckSamples[sampleIndex]! *= attackGain * Math.exp(-sampleIndex / sampleRateHz / pluckDecaySeconds);
  }
  const pluckBuffer = audioContext.createBuffer(1, pluckSamples.length, sampleRateHz);
  // copyToChannel exige un Float32Array respaldado por un ArrayBuffer normal.
  pluckBuffer.copyToChannel(new Float32Array(pluckSamples), 0);
  return pluckBuffer;
}

/**
 * Hace sonar el valor de la fuente mientras `isPlaying`. Lee el último valor de una referencia
 * (no del estado de React) para no reiniciar el audio en cada lectura. Calla en segundo plano.
 */
export function useSonificationPlayer({
  isPlaying,
  mode,
  scaleId,
  latestReadingRef,
}: {
  isPlaying: boolean;
  mode: SonificationMode;
  scaleId: SonificationScaleId;
  latestReadingRef: RefObject<SourceReading | null>;
}) {
  const isAppActive = useIsAppActive();
  const shouldPlay = isPlaying && isAppActive;

  useEffect(() => {
    if (!shouldPlay) return;
    const audioContext = new AudioContext();
    void audioContext.resume().catch(() => undefined);
    let playbackTimer: ReturnType<typeof setInterval>;

    if (mode === 'melody') {
      const pluckBuffersByNote = new Map<number, AudioBuffer>();
      playbackTimer = setInterval(() => {
        const latestReading = latestReadingRef.current;
        if (!latestReading) return;
        const midiNote = normalizedValueToMidiNote(latestReading.normalizedValue, scaleId);
        let pluckBuffer = pluckBuffersByNote.get(midiNote);
        if (!pluckBuffer) {
          pluckBuffer = createPluckBuffer(audioContext, midiNoteToFrequencyHz(midiNote));
          pluckBuffersByNote.set(midiNote, pluckBuffer);
        }
        const pluckSource = audioContext.createBufferSource();
        pluckSource.buffer = pluckBuffer;
        pluckSource.connect(audioContext.destination);
        pluckSource.start();
      }, melodyNoteIntervalMilliseconds);
    } else {
      const thereminOscillator = audioContext.createOscillator();
      const thereminGain = audioContext.createGain();
      thereminOscillator.type = 'sine';
      thereminOscillator.frequency.value = normalizedValueToThereminFrequencyHz(0);
      thereminGain.gain.value = 0;
      thereminOscillator.connect(thereminGain);
      thereminGain.connect(audioContext.destination);
      thereminOscillator.start();
      playbackTimer = setInterval(() => {
        const latestReading = latestReadingRef.current;
        const currentTime = audioContext.currentTime;
        thereminGain.gain.setTargetAtTime(latestReading ? thereminVolume : 0, currentTime, thereminGlideSeconds);
        if (latestReading) {
          thereminOscillator.frequency.setTargetAtTime(
            normalizedValueToThereminFrequencyHz(latestReading.normalizedValue),
            currentTime,
            thereminGlideSeconds,
          );
        }
      }, thereminUpdateMilliseconds);
    }

    return () => {
      clearInterval(playbackTimer);
      void audioContext.close().catch(() => undefined);
    };
  }, [shouldPlay, mode, scaleId, latestReadingRef]);
}
