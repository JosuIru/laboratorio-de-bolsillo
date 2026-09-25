import { useEffect, useRef, useState } from 'react';
import { type AnalyserNode, AudioContext, AudioManager, AudioRecorder, type GainNode } from 'react-native-audio-api';

import { analyserDecibelsToToneAmplitudes } from '@/core/audio/useMicrophoneSpectrum';
import { useIsAppActive } from '@/core/useIsAppActive';
import {
  createGestureClassifier,
  dopplerShiftToVelocityMetersPerSecond,
  estimateDopplerShift,
  type HandGesture,
} from '@/processing/sonar/doppler';
import type { SonarBandPreset } from '@/processing/sonar/hardwareTest';

import { sonarBandFor } from './sonarConfiguration';

/** 4096 muestras: bins de ~12 Hz a 48 kHz y ~85 ms de audio, rápido para seguir una mano. */
const dopplerFftSize = 4096;
const readingIntervalMilliseconds = 60;
const fadeSeconds = 0.03;
/** Por debajo de esto (amplitud) se considera que el micrófono no oye el tono. */
const minimumCarrierAmplitude = 1e-4;

export type DopplerStatus =
  { status: 'idle' } | { status: 'starting' } | { status: 'running' } | { status: 'error'; errorMessage: string };

export interface DopplerReading {
  carrierFrequencyHz: number;
  shiftHz: number;
  velocityMetersPerSecond: number;
  gesture: HandGesture;
  isCarrierHeard: boolean;
  carrierLevelDecibels: number | null;
}

interface DopplerGestureOptions {
  isRunning: boolean;
  bandPreset: SonarBandPreset;
  volume: number;
  temperatureCelsius: number;
}

/**
 * Gestos por Doppler: tono continuo en el centro de la banda por el altavoz y FFT nativa del
 * micrófono. El tono entra y sale con rampas para que no haga clic.
 */
export function useDopplerGestures({ isRunning, bandPreset, volume, temperatureCelsius }: DopplerGestureOptions) {
  const isAppActive = useIsAppActive();
  const shouldRun = isRunning && isAppActive;
  const [dopplerStatus, setDopplerStatus] = useState<DopplerStatus>({ status: 'idle' });
  const [reading, setReading] = useState<DopplerReading | null>(null);
  const temperatureCelsiusRef = useRef(temperatureCelsius);
  const volumeRef = useRef(volume);
  const toneGainRef = useRef<GainNode | null>(null);
  useEffect(() => {
    temperatureCelsiusRef.current = temperatureCelsius;
  }, [temperatureCelsius]);
  useEffect(() => {
    volumeRef.current = volume;
    if (toneGainRef.current) toneGainRef.current.gain.value = volume;
  }, [volume]);

  const runKey = `${shouldRun}-${bandPreset}`;
  const [currentRunKey, setCurrentRunKey] = useState<string | null>(null);
  if (currentRunKey !== runKey) {
    setCurrentRunKey(runKey);
    setDopplerStatus(shouldRun ? { status: 'starting' } : { status: 'idle' });
    setReading(null);
  }

  useEffect(() => {
    if (!shouldRun) return;
    let isCancelled = false;
    let readingTimer: ReturnType<typeof setInterval> | null = null;
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    const toneOscillator = audioContext.createOscillator();
    const toneGain = audioContext.createGain();

    async function startDoppler() {
      try {
        AudioManager.setAudioSessionOptions({
          iosCategory: 'playAndRecord',
          iosMode: 'measurement',
          iosOptions: ['defaultToSpeaker'],
        });
        const sampleRateHz = audioContext.sampleRate;
        const band = sonarBandFor(sampleRateHz, bandPreset);
        const carrierFrequencyHz = (band.lowFrequencyHz + band.highFrequencyHz) / 2;

        const recorderAdapter = audioContext.createRecorderAdapter();
        const analyserNode: AnalyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = dopplerFftSize;
        analyserNode.smoothingTimeConstant = 0;
        analyserNode.minDecibels = -160;
        analyserNode.maxDecibels = 0;
        const silentOutput = audioContext.createGain();
        silentOutput.gain.value = 0;
        audioRecorder.connect(recorderAdapter);
        recorderAdapter.connect(analyserNode);
        analyserNode.connect(silentOutput);
        silentOutput.connect(audioContext.destination);

        toneOscillator.type = 'sine';
        toneOscillator.frequency.value = carrierFrequencyHz;
        toneGain.gain.value = 0;
        toneOscillator.connect(toneGain);
        toneGain.connect(audioContext.destination);

        const startResult = await audioRecorder.start();
        if (isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();
        if (isCancelled) return;
        toneOscillator.start();
        toneGain.gain.setValueAtTime(0, audioContext.currentTime);
        toneGain.gain.linearRampToValueAtTime(volumeRef.current, audioContext.currentTime + fadeSeconds);
        toneGainRef.current = toneGain;
        setDopplerStatus({ status: 'running' });

        const decibelSpectrum = new Float32Array(dopplerFftSize / 2);
        const amplitudeSpectrum = new Float64Array(dopplerFftSize / 2);
        const binResolutionHz = sampleRateHz / dopplerFftSize;
        const gestureClassifier = createGestureClassifier({ minimumSpeedMetersPerSecond: 0.15 });
        readingTimer = setInterval(() => {
          analyserNode.getFloatFrequencyData(decibelSpectrum);
          analyserDecibelsToToneAmplitudes(decibelSpectrum, amplitudeSpectrum);
          const shiftEstimate = estimateDopplerShift(amplitudeSpectrum, {
            sampleRateHz,
            fftSize: dopplerFftSize,
            carrierFrequencyHz,
            // La ventana Blackman del AnalyserNode ensancha el tono unos ±3 bins.
            carrierExclusionHz: 4 * binResolutionHz,
          });
          const isCarrierHeard = shiftEstimate.carrierAmplitude >= minimumCarrierAmplitude;
          const velocityMetersPerSecond = dopplerShiftToVelocityMetersPerSecond(
            shiftEstimate.shiftHz,
            carrierFrequencyHz,
            temperatureCelsiusRef.current,
          );
          const gesture = isCarrierHeard
            ? gestureClassifier.push(
                velocityMetersPerSecond,
                shiftEstimate.upperSidebandRelativePower + shiftEstimate.lowerSidebandRelativePower,
              )
            : 'still';
          setReading({
            carrierFrequencyHz,
            shiftHz: shiftEstimate.shiftHz,
            velocityMetersPerSecond,
            gesture,
            isCarrierHeard,
            carrierLevelDecibels:
              shiftEstimate.carrierAmplitude > 0 ? 20 * Math.log10(shiftEstimate.carrierAmplitude) : null,
          });
        }, readingIntervalMilliseconds);
      } catch (startError) {
        if (!isCancelled) setDopplerStatus({ status: 'error', errorMessage: String(startError) });
      }
    }

    void startDoppler();
    return () => {
      isCancelled = true;
      toneGainRef.current = null;
      if (readingTimer) clearInterval(readingTimer);
      void audioRecorder.stop().catch(() => undefined);
      audioRecorder.disconnect();
      // Rampa de salida y cierre cuando ya ha terminado, para que el altavoz no haga clic.
      try {
        toneGain.gain.cancelScheduledValues(audioContext.currentTime);
        toneGain.gain.setValueAtTime(toneGain.gain.value, audioContext.currentTime);
        toneGain.gain.linearRampToValueAtTime(0, audioContext.currentTime + fadeSeconds);
      } catch {
        // El contexto no llegó a arrancar.
      }
      setTimeout(() => void audioContext.close().catch(() => undefined), fadeSeconds * 2000);
    };
  }, [shouldRun, bandPreset]);

  return { dopplerStatus, reading };
}
