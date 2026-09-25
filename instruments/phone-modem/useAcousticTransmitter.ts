import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioContext, AudioManager } from 'react-native-audio-api';

import { useIsAppActive } from '@/core/useIsAppActive';
import {
  type AcousticModemConfiguration,
  isAcousticConfigurationSupported,
  modulateAcousticFrame,
} from '@/processing/modem/acousticModem';

import { acousticVolume } from './modemConfiguration';

export type AcousticTransmissionState =
  | { status: 'idle' }
  | { status: 'sending'; progress: number; durationSeconds: number }
  | { status: 'sampleRateTooLow'; sampleRateHz: number }
  | { status: 'error'; errorMessage: string };

const progressUpdateMilliseconds = 100;

/**
 * Emite una trama por el altavoz: genera la señal completa, la carga en un búfer y la
 * reproduce una vez. Se corta al salir de la pantalla o al pasar la app a segundo plano.
 */
export function useAcousticTransmitter() {
  const isAppActive = useIsAppActive();
  const [transmissionState, setTransmissionState] = useState<AcousticTransmissionState>({ status: 'idle' });
  const releaseRef = useRef<(() => void) | null>(null);

  const stopTransmission = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const cancelTransmission = useCallback(() => {
    stopTransmission();
    setTransmissionState({ status: 'idle' });
  }, [stopTransmission]);

  // Al pasar a segundo plano se corta la emisión: el estado se ajusta durante el render y el
  // efecto solo libera el audio.
  const [wasAppActive, setWasAppActive] = useState(isAppActive);
  if (wasAppActive !== isAppActive) {
    setWasAppActive(isAppActive);
    if (!isAppActive && transmissionState.status === 'sending') setTransmissionState({ status: 'idle' });
  }
  useEffect(() => {
    if (!isAppActive) stopTransmission();
  }, [isAppActive, stopTransmission]);
  useEffect(() => stopTransmission, [stopTransmission]);

  const transmitFrame = useCallback(
    async (channelBits: readonly number[], configuration: AcousticModemConfiguration) => {
      stopTransmission();
      const audioContext = new AudioContext();
      let progressTimer: ReturnType<typeof setInterval> | null = null;
      let isReleased = false;
      const release = () => {
        if (isReleased) return;
        isReleased = true;
        if (progressTimer) clearInterval(progressTimer);
        void audioContext.close().catch(() => undefined);
      };
      releaseRef.current = release;
      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default', iosOptions: [] });
        const sampleRateHz = audioContext.sampleRate;
        if (!isAcousticConfigurationSupported(configuration, sampleRateHz)) {
          release();
          setTransmissionState({ status: 'sampleRateTooLow', sampleRateHz });
          return;
        }
        const frameSamples = modulateAcousticFrame(channelBits, configuration, sampleRateHz);
        const frameBuffer = audioContext.createBuffer(1, frameSamples.length, sampleRateHz);
        frameBuffer.copyToChannel(frameSamples, 0);
        const frameSource = audioContext.createBufferSource();
        frameSource.buffer = frameBuffer;
        const gainNode = audioContext.createGain();
        gainNode.gain.value = acousticVolume;
        frameSource.connect(gainNode);
        gainNode.connect(audioContext.destination);
        await audioContext.resume();
        if (isReleased) return;
        frameSource.start();
        const durationSeconds = frameSamples.length / sampleRateHz;
        const startMilliseconds = Date.now();
        setTransmissionState({ status: 'sending', progress: 0, durationSeconds });
        progressTimer = setInterval(() => {
          const elapsedMilliseconds = Date.now() - startMilliseconds;
          // Margen de 300 ms para que el final del búfer salga del todo antes de cerrar.
          if (elapsedMilliseconds >= durationSeconds * 1000 + 300) {
            release();
            if (releaseRef.current === release) releaseRef.current = null;
            setTransmissionState({ status: 'idle' });
            return;
          }
          const progress = Math.min(1, elapsedMilliseconds / (durationSeconds * 1000));
          setTransmissionState({ status: 'sending', progress, durationSeconds });
        }, progressUpdateMilliseconds);
      } catch (transmissionError) {
        release();
        setTransmissionState({ status: 'error', errorMessage: String(transmissionError) });
      }
    },
    [stopTransmission],
  );

  return { transmissionState, transmitFrame, cancelTransmission };
}
