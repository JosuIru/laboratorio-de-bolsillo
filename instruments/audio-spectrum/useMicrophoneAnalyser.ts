import { useEffect, useState } from 'react';
import { type AnalyserNode, AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import {
  type ColumnBinMapping,
  createColumnBinMapping,
  createSpectrogramHistory,
  type FrequencyScale,
  pushSpectrumRow,
  type SpectrogramHistory,
} from '@/processing/dsp/spectrogram';

import { startRecorderInOrder, stopRecorderInOrder } from '@/core/audio/recorderQueue';
import { useIsScreenActive } from '@/core/useIsScreenActive';
import { createExponentialSmoother } from '@/processing/signal/smoothing';

import { type AudioFrameAnalysis, createAudioFrameAnalyzer } from './frameAnalysis';

export const analyserFftSize = 4096;
export const spectrogramColumnCount = 160;
export const spectrogramRowCount = 120;
export const minimumDisplayFrequencyHz = 20;
/** ~20 tramas por segundo: fluido y con poco trabajo en el hilo JS (la FFT es nativa). */
const frameIntervalMilliseconds = 50;

export interface MicrophoneFrame {
  sampleRateHz: number;
  analysis: AudioFrameAnalysis;
  /** Nivel suavizado para que la cifra en pantalla se pueda leer. */
  smoothedLevelDecibelsFullScale: number;
  /** Espectro en dB (fftSize/2 bins), reutilizado entre tramas. */
  decibelSpectrum: Float32Array;
  history: SpectrogramHistory;
  columnMapping: ColumnBinMapping;
  revision: number;
}

type MicrophoneState =
  | { status: 'starting' }
  | { status: 'running'; frame: MicrophoneFrame | null }
  /** Pausado por el usuario (o con la pantalla tapada): conserva la última trama para mostrarla. */
  | { status: 'paused'; frame: MicrophoneFrame | null }
  | { status: 'error'; errorMessage: string };

/**
 * Micrófono → AnalyserNode (FFT nativa en C++) → ganancia 0 → salida. La rama silenciada es
 * necesaria porque el grafo de audio solo procesa lo que llega a la salida; con ganancia 0 no
 * se oye nada ni hay realimentación. El hilo JS solo lee el resultado ~20 veces por segundo.
 */
export function useMicrophoneAnalyser({ isRunning, frequencyScale }: { isRunning: boolean; frequencyScale: FrequencyScale }) {
  const isScreenActive = useIsScreenActive();
  const shouldListen = isRunning && isScreenActive;
  const [microphoneState, setMicrophoneState] = useState<MicrophoneState>(
    shouldListen ? { status: 'starting' } : { status: 'paused', frame: null },
  );
  const [history] = useState(() => createSpectrogramHistory(spectrogramRowCount, spectrogramColumnCount));

  // Al reanudar o cambiar de escala se vuelve a «arrancando»; al pausar se conserva la última
  // trama, salvo si cambió la escala (ya no casaría con las etiquetas). Es un ajuste durante el
  // render, el patrón que recomienda React en lugar de un setState dentro del efecto.
  const [listeningSettings, setListeningSettings] = useState({ shouldListen, frequencyScale });
  if (listeningSettings.shouldListen !== shouldListen || listeningSettings.frequencyScale !== frequencyScale) {
    const hasSameScale = listeningSettings.frequencyScale === frequencyScale;
    setListeningSettings({ shouldListen, frequencyScale });
    if (shouldListen) {
      setMicrophoneState({ status: 'starting' });
    } else {
      const lastFrame = microphoneState.status === 'running' || microphoneState.status === 'paused' ? microphoneState.frame : null;
      setMicrophoneState({ status: 'paused', frame: hasSameScale ? lastFrame : null });
    }
  }

  useEffect(() => {
    if (!shouldListen) return;
    let isCancelled = false;
    let frameTimer: ReturnType<typeof setInterval> | null = null;
    let revision = 0;
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();

    async function startListening() {
      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'measurement', iosOptions: [] });
        const recorderAdapter = audioContext.createRecorderAdapter();
        const analyserNode: AnalyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = analyserFftSize;
        analyserNode.smoothingTimeConstant = 0.5;
        analyserNode.minDecibels = -140;
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
        const columnMapping = createColumnBinMapping(
          spectrogramColumnCount,
          sampleRateHz,
          analyserFftSize,
          frequencyScale === 'logarithmic' ? minimumDisplayFrequencyHz : 0,
          Math.min(20_000, sampleRateHz / 2),
          frequencyScale,
        );
        const analyzeFrame = createAudioFrameAnalyzer(analyserFftSize);
        const decibelSpectrum = new Float32Array(analyserFftSize / 2);
        const timeDomainSamples = new Float32Array(analyserFftSize);
        const levelSmoother = createExponentialSmoother(0.25);
        setMicrophoneState({ status: 'running', frame: null });

        frameTimer = setInterval(() => {
          analyserNode.getFloatFrequencyData(decibelSpectrum);
          analyserNode.getFloatTimeDomainData(timeDomainSamples);
          pushSpectrumRow(history, decibelSpectrum, columnMapping);
          revision++;
          const analysis = analyzeFrame(decibelSpectrum, timeDomainSamples, sampleRateHz);
          setMicrophoneState({
            status: 'running',
            frame: {
              sampleRateHz,
              analysis,
              smoothedLevelDecibelsFullScale: levelSmoother.push(analysis.levelDecibelsFullScale),
              decibelSpectrum,
              history,
              columnMapping,
              revision,
            },
          });
        }, frameIntervalMilliseconds);
      } catch (startError) {
        if (!isCancelled) setMicrophoneState({ status: 'error', errorMessage: String(startError) });
      }
    }

    void startListening();

    return () => {
      isCancelled = true;
      if (frameTimer) clearInterval(frameTimer);
      void stopRecorderInOrder(audioRecorder);
      audioRecorder.disconnect();
      void audioContext.close().catch(() => undefined);
    };
  }, [shouldListen, frequencyScale, history]);

  return { microphoneState, isListening: shouldListen };
}
