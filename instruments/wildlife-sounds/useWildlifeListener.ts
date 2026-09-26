import { useEffect, useRef, useState } from 'react';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { startRecorderInOrder, stopRecorderInOrder } from '@/core/audio/recorderQueue';
import { useIsScreenActive } from '@/core/useIsScreenActive';

import { resampleWithLowPass } from './audioResampling';
import { chooseHopSeconds, createAudioWindowCollector, rootMeanSquareDecibels } from './audioWindowing';
import type { WildlifeClassifier, WindowClassification } from './wildlifeClassifier';

export type ListenerState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'listening'; inputSampleRateHz: number }
  | { status: 'error'; errorMessage: string };

export interface AnalyzedWindow {
  classification: WindowClassification;
  /** Hora del final de la ventana (epoch ms). */
  windowEndTimestamp: number;
  windowSeconds: number;
  resampleMilliseconds: number;
  /** Remuestreo + modelo. */
  analysisMilliseconds: number;
  hopSeconds: number;
  levelDecibels: number;
}

/** Bloques de ≈85 ms a 48 kHz: de sobra para trocear en ventanas de 5 s. */
const recorderBufferLength = 4096;

interface WildlifeListenerOptions {
  isListening: boolean;
  classifier: WildlifeClassifier | null;
  onWindowAnalyzed(analyzedWindow: AnalyzedWindow): void;
  onAnalysisError(errorMessage: string): void;
}

/**
 * Escucha el micrófono sin parar y, cada 2,5 s (o 5 s si el móvil va justo), pasa los últimos
 * 5 s al modelo. Mientras se analiza una ventana no se empieza otra: si el análisis se retrasa,
 * se salta a la más reciente. Se para al pausar, al salir de la pantalla o al pasar la app a
 * segundo plano. El audio solo vive en memoria: no se guarda.
 */
export function useWildlifeListener({ isListening, classifier, onWindowAnalyzed, onAnalysisError }: WildlifeListenerOptions) {
  const isScreenActive = useIsScreenActive();
  const shouldListen = isListening && isScreenActive && classifier !== null;
  const [listenerState, setListenerState] = useState<ListenerState>({ status: 'idle' });
  const onWindowAnalyzedRef = useRef(onWindowAnalyzed);
  const onAnalysisErrorRef = useRef(onAnalysisError);
  useEffect(() => {
    onWindowAnalyzedRef.current = onWindowAnalyzed;
    onAnalysisErrorRef.current = onAnalysisError;
  }, [onWindowAnalyzed, onAnalysisError]);

  const [wasListening, setWasListening] = useState(shouldListen);
  if (wasListening !== shouldListen) {
    setWasListening(shouldListen);
    setListenerState(shouldListen ? { status: 'starting' } : { status: 'idle' });
  }

  useEffect(() => {
    if (!shouldListen || !classifier) return;
    let isCancelled = false;
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    const { sampleRateHz: modelSampleRateHz, windowSamples: modelWindowSamples } = classifier.manifest;
    const windowSeconds = modelWindowSamples / modelSampleRateHz;
    let inputSampleRateHz = 0;
    let windowCollector: ReturnType<typeof createAudioWindowCollector> | null = null;
    let isAnalyzing = false;
    let lastAnalysisMilliseconds: number | null = null;

    function releaseAudio() {
      if (isCancelled) return;
      isCancelled = true;
      audioRecorder.clearOnAudioReady();
      void stopRecorderInOrder(audioRecorder);
      void audioContext.close().catch(() => undefined);
    }

    async function analyzeWindow(sourceWindow: Float32Array, hopSeconds: number) {
      isAnalyzing = true;
      const windowEndTimestamp = Date.now();
      try {
        const analysisStartedAt = performance.now();
        // Remuestrear 5 s ocupa el hilo JS ~100 ms: es lo único que no se hace en nativo.
        const modelWindow = resampleWithLowPass(sourceWindow, inputSampleRateHz, modelSampleRateHz, modelWindowSamples);
        const resampleMilliseconds = performance.now() - analysisStartedAt;
        const classification = await classifier!.classifyWindow(modelWindow);
        const analysisMilliseconds = performance.now() - analysisStartedAt;
        lastAnalysisMilliseconds = analysisMilliseconds;
        if (isCancelled) return;
        onWindowAnalyzedRef.current({
          classification,
          windowEndTimestamp,
          windowSeconds,
          resampleMilliseconds,
          analysisMilliseconds,
          hopSeconds,
          levelDecibels: rootMeanSquareDecibels(modelWindow),
        });
      } catch (analysisError) {
        if (!isCancelled) onAnalysisErrorRef.current(String(analysisError));
      } finally {
        isAnalyzing = false;
      }
    }

    async function startListening() {
      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'measurement', iosOptions: [] });
        audioRecorder.onAudioReady(
          { sampleRate: audioContext.sampleRate, bufferLength: recorderBufferLength, channelCount: 1 },
          (audioEvent) => {
            if (isCancelled) return;
            if (!windowCollector) {
              // La frecuencia real puede no ser la pedida: manda la del primer bloque.
              inputSampleRateHz = audioEvent.buffer.sampleRate;
              windowCollector = createAudioWindowCollector(Math.round(windowSeconds * inputSampleRateHz));
              setListenerState({ status: 'listening', inputSampleRateHz });
            }
            windowCollector.pushSamples(audioEvent.buffer.getChannelData(0));
            if (isAnalyzing) return;
            const hopSeconds = chooseHopSeconds(lastAnalysisMilliseconds);
            const sourceWindow = windowCollector.takeWindowIfReady(Math.round(hopSeconds * inputSampleRateHz));
            if (sourceWindow) void analyzeWindow(sourceWindow, hopSeconds);
          },
        );
        const startResult = await startRecorderInOrder(audioRecorder, () => isCancelled);
        if (!startResult || isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();
      } catch (startError) {
        if (!isCancelled) {
          releaseAudio();
          setListenerState({ status: 'error', errorMessage: String(startError) });
        }
      }
    }

    void startListening();
    return releaseAudio;
  }, [shouldListen, classifier]);

  return { listenerState, isScreenActive };
}
