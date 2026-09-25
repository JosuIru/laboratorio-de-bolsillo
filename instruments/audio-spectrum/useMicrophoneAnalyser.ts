import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { type AnalyserNode, AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import {
  type ColumnBinMapping,
  createColumnBinMapping,
  createSpectrogramHistory,
  type FrequencyScale,
  pushSpectrumRow,
  type SpectrogramHistory,
} from '@/processing/dsp/spectrogram';

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
  | { status: 'error'; errorMessage: string };

/** Solo escucha mientras la app está en primer plano: el micrófono nunca queda abierto de fondo. */
function useIsAppActive(): boolean {
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const appStateSubscription = AppState.addEventListener('change', (nextAppState) =>
      setIsAppActive(nextAppState === 'active'),
    );
    return () => appStateSubscription.remove();
  }, []);
  return isAppActive;
}

/**
 * Micrófono → AnalyserNode (FFT nativa en C++) → ganancia 0 → salida. La rama silenciada es
 * necesaria porque el grafo de audio solo procesa lo que llega a la salida; con ganancia 0 no
 * se oye nada ni hay realimentación. El hilo JS solo lee el resultado ~20 veces por segundo.
 */
export function useMicrophoneAnalyser({ isRunning, frequencyScale }: { isRunning: boolean; frequencyScale: FrequencyScale }) {
  const isAppActive = useIsAppActive();
  const shouldListen = isRunning && isAppActive;
  const [microphoneState, setMicrophoneState] = useState<MicrophoneState>({ status: 'starting' });
  const [history] = useState(() => createSpectrogramHistory(spectrogramRowCount, spectrogramColumnCount));

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

        const startResult = await audioRecorder.start();
        if (isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();

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

    setMicrophoneState({ status: 'starting' });
    void startListening();

    return () => {
      isCancelled = true;
      if (frameTimer) clearInterval(frameTimer);
      void audioRecorder.stop().catch(() => undefined);
      audioRecorder.disconnect();
      void audioContext.close().catch(() => undefined);
    };
  }, [shouldListen, frequencyScale, history]);

  return { microphoneState, isListening: shouldListen };
}
