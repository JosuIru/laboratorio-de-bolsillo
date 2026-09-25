import { useEffect, useEffectEvent, useState } from 'react';
import { type AnalyserNode, AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { useIsAppActive } from '@/core/useIsAppActive';

export interface MicrophoneSpectrumOptions {
  /** Escucha solo mientras sea `true` (y la app esté en primer plano). */
  isActive: boolean;
  /** Potencia de 2 entre 32 y 32768. */
  fftSize: number;
  /** Promediado del AnalyserNode entre tramas (0 = ninguno). */
  smoothingTimeConstant?: number;
  frameIntervalMilliseconds?: number;
  /**
   * Se llama con cada trama. `decibelSpectrum` (fftSize/2 bins, dBFS según Web Audio) y
   * `timeDomainSamples` se reutilizan: cópialos si los necesitas guardar.
   */
  onFrame(frame: { decibelSpectrum: Float32Array; timeDomainSamples: Float32Array; sampleRateHz: number }): void;
}

export type MicrophoneSpectrumStatus =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'running'; sampleRateHz: number }
  | { status: 'error'; errorMessage: string };

/**
 * Micrófono → AnalyserNode (FFT nativa) → ganancia 0 → salida. La rama silenciada es necesaria
 * porque el grafo solo procesa lo que llega a la salida; con ganancia 0 no se oye nada.
 * El micrófono se cierra al desactivar, al desmontar y al pasar la app a segundo plano.
 */
export function useMicrophoneSpectrum({
  isActive,
  fftSize,
  smoothingTimeConstant = 0,
  frameIntervalMilliseconds = 100,
  onFrame,
}: MicrophoneSpectrumOptions): MicrophoneSpectrumStatus {
  const isAppActive = useIsAppActive();
  const shouldListen = isActive && isAppActive;
  const handleFrame = useEffectEvent(onFrame);
  const [microphoneStatus, setMicrophoneStatus] = useState<MicrophoneSpectrumStatus>({ status: 'idle' });

  // Ajuste durante el render (no dentro del efecto) al empezar o dejar de escuchar.
  const listeningKey = `${shouldListen}-${fftSize}`;
  const [currentListeningKey, setCurrentListeningKey] = useState<string | null>(null);
  if (currentListeningKey !== listeningKey) {
    setCurrentListeningKey(listeningKey);
    setMicrophoneStatus(shouldListen ? { status: 'starting' } : { status: 'idle' });
  }

  useEffect(() => {
    if (!shouldListen) return;
    let isCancelled = false;
    let frameTimer: ReturnType<typeof setInterval> | null = null;
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();

    async function startListening() {
      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'measurement', iosOptions: [] });
        const recorderAdapter = audioContext.createRecorderAdapter();
        const analyserNode: AnalyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = fftSize;
        analyserNode.smoothingTimeConstant = smoothingTimeConstant;
        analyserNode.minDecibels = -160;
        analyserNode.maxDecibels = 0;
        const silentOutput = audioContext.createGain();
        silentOutput.gain.value = 0;
        audioRecorder.connect(recorderAdapter);
        recorderAdapter.connect(analyserNode);
        analyserNode.connect(silentOutput);
        silentOutput.connect(audioContext.destination);

        const startResult = await audioRecorder.start();
        if (isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();
        if (isCancelled) return;

        const sampleRateHz = audioContext.sampleRate;
        const decibelSpectrum = new Float32Array(fftSize / 2);
        const timeDomainSamples = new Float32Array(fftSize);
        setMicrophoneStatus({ status: 'running', sampleRateHz });
        frameTimer = setInterval(() => {
          analyserNode.getFloatFrequencyData(decibelSpectrum);
          analyserNode.getFloatTimeDomainData(timeDomainSamples);
          handleFrame({ decibelSpectrum, timeDomainSamples, sampleRateHz });
        }, frameIntervalMilliseconds);
      } catch (startError) {
        if (!isCancelled) setMicrophoneStatus({ status: 'error', errorMessage: String(startError) });
      }
    }

    void startListening();
    return () => {
      isCancelled = true;
      if (frameTimer) clearInterval(frameTimer);
      void audioRecorder.stop().catch(() => undefined);
      audioRecorder.disconnect();
      void audioContext.close().catch(() => undefined);
    };
  }, [shouldListen, fftSize, smoothingTimeConstant, frameIntervalMilliseconds]);

  return microphoneStatus;
}

/**
 * Convierte el espectro en dB del AnalyserNode en amplitud de tono (una senoidal de amplitud A
 * da A en su bin): el AnalyserNode aplica Blackman (ganancia 0,42) y divide entre N.
 */
export function analyserDecibelsToToneAmplitudes(decibelSpectrum: ArrayLike<number>, output: Float64Array): Float64Array {
  const toneCorrectionFactor = 2 / 0.42;
  for (let binIndex = 0; binIndex < output.length; binIndex++) {
    const binDecibels = decibelSpectrum[binIndex] ?? -Infinity;
    output[binIndex] = Number.isFinite(binDecibels) ? toneCorrectionFactor * 10 ** (binDecibels / 20) : 0;
  }
  return output;
}
