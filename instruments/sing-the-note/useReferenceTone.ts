import { useCallback, useEffect, useRef } from 'react';
import { AudioContext } from 'react-native-audio-api';

import { applyFadesInPlace, generateTone } from '@/processing/dsp/signalGenerator';

export const referenceToneSeconds = 1.2;
const referenceToneAmplitude = 0.4;
const referenceToneFadeSeconds = 0.03;

/**
 * Toca la nota de referencia. Onda triangular: suave como una flauta, pero con armónicos, que
 * ayudan a oír la altura mejor que una senoidal pura. El contexto de audio se crea al primer uso
 * y se cierra al salir de la pantalla.
 */
export function useReferenceTone() {
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(
    () => () => {
      void audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
    },
    [],
  );

  const playReferenceTone = useCallback((frequencyHz: number) => {
    audioContextRef.current ??= new AudioContext();
    const audioContext = audioContextRef.current;
    const sampleRateHz = audioContext.sampleRate;
    const toneSamples = generateTone({
      frequencyHz,
      sampleRateHz,
      durationSeconds: referenceToneSeconds,
      amplitude: referenceToneAmplitude,
      waveform: 'triangle',
    });
    applyFadesInPlace(toneSamples, Math.round(referenceToneFadeSeconds * sampleRateHz));
    const toneBuffer = audioContext.createBuffer(1, toneSamples.length, sampleRateHz);
    // copyToChannel exige un Float32Array respaldado por un ArrayBuffer normal.
    toneBuffer.copyToChannel(new Float32Array(toneSamples), 0);
    const toneSource = audioContext.createBufferSource();
    toneSource.buffer = toneBuffer;
    toneSource.connect(audioContext.destination);
    void audioContext.resume().catch(() => undefined);
    toneSource.start();
  }, []);

  return { playReferenceTone };
}
