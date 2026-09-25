import { useEffect, useState } from 'react';
import { type AnalyserNode, AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { startRecorderInOrder, stopRecorderInOrder } from '@/core/audio/recorderQueue';
import { useIsScreenActive } from '@/core/useIsScreenActive';
import { type FundamentalEstimate, estimateFundamentalFrequency } from '@/processing/dsp/fundamentalFrequency';

import { createReadingStabilizer, type StabilizedReading } from './rpmReading';

/**
 * FFT larga: a 48 kHz, 16384 muestras dan bins de ~2,9 Hz (0,34 s de audio). Con la
 * interpolación del pico basta para ±0,5 % a partir de unos 50 Hz de pulsos.
 */
export const tachometerFftSize = 16384;
/** Pulsos entre 5 y 2000 Hz: de 300 rpm con un pulso por vuelta a 120 000 rpm. */
export const minimumPulseFrequencyHz = 5;
export const maximumPulseFrequencyHz = 2000;
const readingIntervalMilliseconds = 100;

export interface TachometerFrame {
  sampleRateHz: number;
  fftSize: number;
  /** Última estimación cruda (null si en esta trama no había un tono claro). */
  latestEstimate: FundamentalEstimate | null;
  stabilizedReading: StabilizedReading | null;
}

type TachometerMicrophoneState =
  | { status: 'starting' }
  | { status: 'running'; frame: TachometerFrame | null }
  /** En pausa (o con la pantalla tapada): conserva la última lectura para mostrarla. */
  | { status: 'paused'; frame: TachometerFrame | null }
  | { status: 'error'; errorMessage: string };

/**
 * Micrófono → AnalyserNode (FFT nativa) → ganancia 0 → salida, como el analizador de espectro.
 * Solo escucha con la pantalla visible, en primer plano y mientras no esté en pausa.
 */
export function useTachometerMicrophone({ isRunning }: { isRunning: boolean }) {
  const isScreenActive = useIsScreenActive();
  const shouldListen = isRunning && isScreenActive;
  const [microphoneState, setMicrophoneState] = useState<TachometerMicrophoneState>(
    shouldListen ? { status: 'starting' } : { status: 'paused', frame: null },
  );

  const [previousShouldListen, setPreviousShouldListen] = useState(shouldListen);
  if (previousShouldListen !== shouldListen) {
    setPreviousShouldListen(shouldListen);
    if (shouldListen) {
      setMicrophoneState({ status: 'starting' });
    } else {
      const lastFrame = microphoneState.status === 'running' || microphoneState.status === 'paused' ? microphoneState.frame : null;
      setMicrophoneState({ status: 'paused', frame: lastFrame });
    }
  }

  useEffect(() => {
    if (!shouldListen) return;
    let isCancelled = false;
    let readingTimer: ReturnType<typeof setInterval> | null = null;
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();

    async function startListening() {
      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'measurement', iosOptions: [] });
        const recorderAdapter = audioContext.createRecorderAdapter();
        const analyserNode: AnalyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = tachometerFftSize;
        // Sin promediado entre tramas: la estabilidad la da la mediana de lecturas, que no
        // arrastra el valor anterior cuando el motor cambia de régimen.
        analyserNode.smoothingTimeConstant = 0;
        analyserNode.minDecibels = -160;
        analyserNode.maxDecibels = 0;
        const silentOutput = audioContext.createGain();
        silentOutput.gain.value = 0;
        audioRecorder.connect(recorderAdapter);
        recorderAdapter.connect(analyserNode);
        analyserNode.connect(silentOutput);
        silentOutput.connect(audioContext.destination);

        // La cola espera a que otros grabadores se paren y, si se cancela, deja este parado.
        const startResult = await startRecorderInOrder(audioRecorder, () => isCancelled);
        if (!startResult || isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();
        if (isCancelled) return;

        const sampleRateHz = audioContext.sampleRate;
        const decibelSpectrum = new Float32Array(tachometerFftSize / 2);
        const amplitudeSpectrum = new Float64Array(tachometerFftSize / 2);
        const readingStabilizer = createReadingStabilizer();
        setMicrophoneState({ status: 'running', frame: null });

        readingTimer = setInterval(() => {
          analyserNode.getFloatFrequencyData(decibelSpectrum);
          for (let binIndex = 0; binIndex < decibelSpectrum.length; binIndex++) {
            const binDecibels = decibelSpectrum[binIndex]!;
            amplitudeSpectrum[binIndex] = Number.isFinite(binDecibels) ? 10 ** (binDecibels / 20) : 0;
          }
          const latestEstimate = estimateFundamentalFrequency(amplitudeSpectrum, {
            sampleRateHz,
            fftSize: tachometerFftSize,
            minimumFrequencyHz: minimumPulseFrequencyHz,
            maximumFrequencyHz: Math.min(maximumPulseFrequencyHz, sampleRateHz / 2),
          });
          setMicrophoneState({
            status: 'running',
            frame: {
              sampleRateHz,
              fftSize: tachometerFftSize,
              latestEstimate,
              stabilizedReading: readingStabilizer.push(latestEstimate?.frequencyHz ?? null),
            },
          });
        }, readingIntervalMilliseconds);
      } catch (startError) {
        if (!isCancelled) setMicrophoneState({ status: 'error', errorMessage: String(startError) });
      }
    }

    void startListening();

    return () => {
      isCancelled = true;
      if (readingTimer) clearInterval(readingTimer);
      void stopRecorderInOrder(audioRecorder);
      audioRecorder.disconnect();
      void audioContext.close().catch(() => undefined);
    };
  }, [shouldListen]);

  return { microphoneState, isListening: shouldListen };
}
