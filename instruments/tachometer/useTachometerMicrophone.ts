import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { type AnalyserNode, AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

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
  | { status: 'error'; errorMessage: string };

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
 * Micrófono → AnalyserNode (FFT nativa) → ganancia 0 → salida, como el analizador de espectro.
 * Solo escucha en primer plano y mientras no esté en pausa.
 */
export function useTachometerMicrophone({ isRunning }: { isRunning: boolean }) {
  const isAppActive = useIsAppActive();
  const shouldListen = isRunning && isAppActive;
  const [microphoneState, setMicrophoneState] = useState<TachometerMicrophoneState>({ status: 'starting' });

  const [previousShouldListen, setPreviousShouldListen] = useState(shouldListen);
  if (previousShouldListen !== shouldListen) {
    setPreviousShouldListen(shouldListen);
    setMicrophoneState({ status: 'starting' });
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

        const startResult = await audioRecorder.start();
        if (isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();

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
      void audioRecorder.stop().catch(() => undefined);
      audioRecorder.disconnect();
      void audioContext.close().catch(() => undefined);
    };
  }, [shouldListen]);

  return { microphoneState, isListening: shouldListen };
}
