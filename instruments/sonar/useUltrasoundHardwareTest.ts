import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { analyserDecibelsToToneAmplitudes } from '@/core/audio/useMicrophoneSpectrum';
import { useIsAppActive } from '@/core/useIsAppActive';
import {
  type HardwareBandResult,
  type HardwareTestSummary,
  hardwareTestFrequenciesHz,
  measureBandResult,
  summarizeHardwareTest,
  toneAmplitudeAt,
} from '@/processing/sonar/hardwareTest';

const analyserFftSize = 4096;
/** Tiempo para que el micrófono se estabilice antes de medir el ruido. */
const settleMilliseconds = 600;
/** Tiempo de cada tono: la FFT (85 ms a 48 kHz) cabe de sobra después del cambio. */
const toneStepMilliseconds = 350;
const noiseReadingCount = 4;
const fadeSeconds = 0.03;

export type HardwareTestState =
  | { phase: 'idle' }
  | { phase: 'running'; currentFrequencyHz: number | null; completedStepCount: number; totalStepCount: number }
  | { phase: 'done'; bandResults: HardwareBandResult[]; summary: HardwareTestSummary; sampleRateHz: number }
  | { phase: 'error'; errorMessage: string };

interface ActiveTest {
  audioContext: AudioContext;
  audioRecorder: AudioRecorder;
}

function waitMilliseconds(durationMilliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

/**
 * Barrido por pasos de 15 a 22 kHz: primero mide el ruido de fondo en cada frecuencia con el
 * altavoz callado y luego emite cada tono y mide cuánto sobresale. Así se sabe si el móvil
 * emite y capta ultrasonidos. Se cancela al salir de la pantalla o de la app.
 */
export function useUltrasoundHardwareTest(volume: number) {
  const isAppActive = useIsAppActive();
  const [testState, setTestState] = useState<HardwareTestState>({ phase: 'idle' });
  const activeTestRef = useRef<ActiveTest | null>(null);

  const stopAudio = useCallback(() => {
    const activeTest = activeTestRef.current;
    if (!activeTest) return;
    activeTestRef.current = null;
    void activeTest.audioRecorder.stop().catch(() => undefined);
    activeTest.audioRecorder.disconnect();
    void activeTest.audioContext.close().catch(() => undefined);
  }, []);

  const cancelTest = useCallback(() => {
    stopAudio();
    setTestState({ phase: 'idle' });
  }, [stopAudio]);

  const [wasAppActive, setWasAppActive] = useState(isAppActive);
  if (wasAppActive !== isAppActive) {
    setWasAppActive(isAppActive);
    if (!isAppActive && testState.phase === 'running') setTestState({ phase: 'idle' });
  }
  useEffect(() => {
    if (!isAppActive) stopAudio();
  }, [isAppActive, stopAudio]);
  useEffect(() => stopAudio, [stopAudio]);

  const runTest = useCallback(async () => {
    stopAudio();
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    const activeTest: ActiveTest = { audioContext, audioRecorder };
    activeTestRef.current = activeTest;
    const isCurrentTest = () => activeTestRef.current === activeTest;

    try {
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
        iosMode: 'measurement',
        iosOptions: ['defaultToSpeaker'],
      });
      const sampleRateHz = audioContext.sampleRate;
      const testFrequenciesHz = hardwareTestFrequenciesHz(sampleRateHz);
      setTestState({
        phase: 'running',
        currentFrequencyHz: null,
        completedStepCount: 0,
        totalStepCount: testFrequenciesHz.length,
      });

      const recorderAdapter = audioContext.createRecorderAdapter();
      const analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = analyserFftSize;
      analyserNode.smoothingTimeConstant = 0;
      analyserNode.minDecibels = -160;
      analyserNode.maxDecibels = 0;
      const silentOutput = audioContext.createGain();
      silentOutput.gain.value = 0;
      audioRecorder.connect(recorderAdapter);
      recorderAdapter.connect(analyserNode);
      analyserNode.connect(silentOutput);
      silentOutput.connect(audioContext.destination);

      const toneOscillator = audioContext.createOscillator();
      const toneGain = audioContext.createGain();
      toneGain.gain.value = 0;
      toneOscillator.connect(toneGain);
      toneGain.connect(audioContext.destination);

      const startResult = await audioRecorder.start();
      if (!isCurrentTest()) {
        // Si la limpieza paró el grabador antes de que acabara de arrancar, seguiría grabando.
        if (startResult.status !== 'error') void audioRecorder.stop().catch(() => undefined);
        return;
      }
      if (startResult.status === 'error') throw new Error(startResult.message);
      await audioContext.resume();
      toneOscillator.frequency.value = testFrequenciesHz[0] ?? 15000;
      toneOscillator.start();
      await waitMilliseconds(settleMilliseconds);
      if (!isCurrentTest()) return;

      const decibelSpectrum = new Float32Array(analyserFftSize / 2);
      const amplitudeSpectrum = new Float64Array(analyserFftSize / 2);
      const readToneAmplitude = (frequencyHz: number) => {
        analyserNode.getFloatFrequencyData(decibelSpectrum);
        analyserDecibelsToToneAmplitudes(decibelSpectrum, amplitudeSpectrum);
        return toneAmplitudeAt(amplitudeSpectrum, frequencyHz, sampleRateHz, analyserFftSize);
      };

      // Ruido de fondo en cada frecuencia (altavoz callado), promediando varias lecturas.
      const noiseAmplitudes = testFrequenciesHz.map(() => 0);
      for (let readingIndex = 0; readingIndex < noiseReadingCount; readingIndex++) {
        testFrequenciesHz.forEach((frequencyHz, frequencyIndex) => {
          noiseAmplitudes[frequencyIndex]! += readToneAmplitude(frequencyHz) / noiseReadingCount;
        });
        await waitMilliseconds(100);
        if (!isCurrentTest()) return;
      }

      toneGain.gain.setValueAtTime(0, audioContext.currentTime);
      toneGain.gain.linearRampToValueAtTime(volume, audioContext.currentTime + fadeSeconds);
      const bandResults: HardwareBandResult[] = [];
      for (const [frequencyIndex, frequencyHz] of testFrequenciesHz.entries()) {
        // El oscilador cambia de frecuencia sin saltos de fase: no hace clic.
        toneOscillator.frequency.setValueAtTime(frequencyHz, audioContext.currentTime);
        setTestState({
          phase: 'running',
          currentFrequencyHz: frequencyHz,
          completedStepCount: frequencyIndex,
          totalStepCount: testFrequenciesHz.length,
        });
        await waitMilliseconds(toneStepMilliseconds);
        if (!isCurrentTest()) return;
        bandResults.push(
          measureBandResult(frequencyHz, readToneAmplitude(frequencyHz), noiseAmplitudes[frequencyIndex]!),
        );
      }
      // Fundido de salida anclado al valor actual: sin el ancla la rampa empezaría en el último
      // evento programado y la ganancia caería de golpe (clic).
      const fadeOutStartSeconds = audioContext.currentTime;
      toneGain.gain.cancelScheduledValues(fadeOutStartSeconds);
      toneGain.gain.setValueAtTime(toneGain.gain.value, fadeOutStartSeconds);
      toneGain.gain.linearRampToValueAtTime(0, fadeOutStartSeconds + fadeSeconds);
      await waitMilliseconds(fadeSeconds * 2000);
      if (!isCurrentTest()) return;
      stopAudio();
      setTestState({ phase: 'done', bandResults, summary: summarizeHardwareTest(bandResults), sampleRateHz });
    } catch (testError) {
      if (isCurrentTest()) {
        stopAudio();
        setTestState({ phase: 'error', errorMessage: String(testError) });
      }
    }
  }, [stopAudio, volume]);

  return { testState, runTest, cancelTest };
}
