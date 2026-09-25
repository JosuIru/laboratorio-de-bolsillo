import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

import { analyserDecibelsToToneAmplitudes, useMicrophoneSpectrum } from '@/core/audio/useMicrophoneSpectrum';
import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { bandPowersFromAmplitudeSpectrum, createFractionalOctaveBands } from '@/processing/dsp/frequencyBands';
import { createVibrationAnalyzer } from '@/processing/dsp/vibrationAnalysis';
import { createDomainAccumulator, type MachineFingerprint } from '@/processing/diagnostics/machineFingerprint';
import {
  copyLatestFromRingBuffer,
  createRingBuffer,
  pushToRingBuffer,
  type RingBuffer,
} from '@/processing/signal/ringBuffer';

export const captureDurationSeconds = 10;
const microphoneFftSize = 8192;
const vibrationFftSize = 256;
const vibrationHistoryCapacity = 1024;
const progressIntervalMilliseconds = 250;
const vibrationAnalysisIntervalMilliseconds = 1000;

/**
 * Bandas fijas para que todas las huellas sean comparables entre sí: tercios de octava de
 * 25 Hz a 16 kHz para el sonido y de 2 a 63 Hz para la vibración (el acelerómetro del móvil
 * no pasa de ~100-200 Hz de Nyquist).
 */
export const audioBands = createFractionalOctaveBands(3, 25, 16_000);
export const vibrationBands = createFractionalOctaveBands(3, 2, 63);

type CaptureState =
  | { status: 'idle' }
  | { status: 'capturing'; progress: number }
  | { status: 'done'; fingerprint: MachineFingerprint }
  | { status: 'error'; errorMessage: string };

interface CaptureSession {
  startedAt: number;
  audioAccumulator: ReturnType<typeof createDomainAccumulator>;
  vibrationAccumulator: ReturnType<typeof createDomainAccumulator>;
  timestamps: RingBuffer;
  axisX: RingBuffer;
  axisY: RingBuffer;
  axisZ: RingBuffer;
}

function createCaptureSession(): CaptureSession {
  return {
    startedAt: Date.now(),
    audioAccumulator: createDomainAccumulator(audioBands.map((band) => band.centerHz)),
    vibrationAccumulator: createDomainAccumulator(vibrationBands.map((band) => band.centerHz)),
    timestamps: createRingBuffer(vibrationHistoryCapacity),
    axisX: createRingBuffer(vibrationHistoryCapacity),
    axisY: createRingBuffer(vibrationHistoryCapacity),
    axisZ: createRingBuffer(vibrationHistoryCapacity),
  };
}

/**
 * Graba una huella: micrófono y acelerómetro a la vez durante `captureDurationSeconds`.
 * Los dos sensores solo están abiertos mientras dura la grabación. Al terminar llama a
 * `onCaptureComplete` con la huella (en el momento del evento, no desde un efecto).
 */
export function useFingerprintCapture({
  onCaptureComplete,
}: {
  onCaptureComplete(fingerprint: MachineFingerprint): void;
}) {
  const notifyCaptureComplete = useEffectEvent(onCaptureComplete);
  const [captureState, setCaptureState] = useState<CaptureState>({ status: 'idle' });
  const captureSession = useRef<CaptureSession | null>(null);
  const [vibrationAnalyzer] = useState(() => createVibrationAnalyzer(vibrationFftSize));
  const [toneAmplitudes] = useState(() => new Float64Array(microphoneFftSize / 2));
  const isCapturing = captureState.status === 'capturing';

  const microphoneStatus = useMicrophoneSpectrum({
    isActive: isCapturing,
    fftSize: microphoneFftSize,
    frameIntervalMilliseconds: 100,
    onFrame: ({ decibelSpectrum, sampleRateHz }) => {
      const session = captureSession.current;
      if (!session) return;
      analyserDecibelsToToneAmplitudes(decibelSpectrum, toneAmplitudes);
      session.audioAccumulator.push(
        bandPowersFromAmplitudeSpectrum(toneAmplitudes, sampleRateHz, microphoneFftSize, audioBands),
      );
    },
  });

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      const session = captureSession.current;
      if (!session) return;
      pushToRingBuffer(session.timestamps, timestampSeconds);
      pushToRingBuffer(session.axisX, value.x);
      pushToRingBuffer(session.axisY, value.y);
      pushToRingBuffer(session.axisZ, value.z);
    },
    { isActive: isCapturing, targetRateHz: 250 },
  );

  useEffect(() => {
    if (!isCapturing) return;
    const analyzeVibration = () => {
      const session = captureSession.current;
      if (!session) return;
      const sampleCount = session.timestamps.storedCount;
      const readAxis = (axisBuffer: RingBuffer) => {
        const axisValues = new Float64Array(sampleCount);
        copyLatestFromRingBuffer(axisBuffer, axisValues);
        return axisValues;
      };
      const vibrationAnalysis = vibrationAnalyzer.analyze({
        timestampsSeconds: readAxis(session.timestamps),
        x: readAxis(session.axisX),
        y: readAxis(session.axisY),
        z: readAxis(session.axisZ),
      });
      if (vibrationAnalysis) {
        session.vibrationAccumulator.push(
          bandPowersFromAmplitudeSpectrum(
            vibrationAnalysis.spectrumAmplitudes,
            vibrationAnalysis.sampleRateHz,
            vibrationFftSize,
            vibrationBands,
          ),
        );
      }
    };
    const vibrationTimer = setInterval(analyzeVibration, vibrationAnalysisIntervalMilliseconds);
    const progressTimer = setInterval(() => {
      const session = captureSession.current;
      if (!session) return;
      const elapsedSeconds = (Date.now() - session.startedAt) / 1000;
      if (elapsedSeconds < captureDurationSeconds) {
        setCaptureState({ status: 'capturing', progress: elapsedSeconds / captureDurationSeconds });
        return;
      }
      analyzeVibration();
      const fingerprint: MachineFingerprint = {
        audio: session.audioAccumulator.finish(),
        vibration: session.vibrationAccumulator.finish(),
        capturedAt: Date.now(),
        durationSeconds: Math.round(elapsedSeconds * 10) / 10,
      };
      captureSession.current = null;
      if (fingerprint.audio || fingerprint.vibration) {
        setCaptureState({ status: 'done', fingerprint });
        notifyCaptureComplete(fingerprint);
      } else {
        setCaptureState({ status: 'error', errorMessage: 'no-data' });
      }
    }, progressIntervalMilliseconds);
    return () => {
      clearInterval(vibrationTimer);
      clearInterval(progressTimer);
    };
  }, [isCapturing, vibrationAnalyzer]);

  const startCapture = useCallback(() => {
    captureSession.current = createCaptureSession();
    setCaptureState({ status: 'capturing', progress: 0 });
  }, []);

  const cancelCapture = useCallback(() => {
    captureSession.current = null;
    setCaptureState({ status: 'idle' });
  }, []);

  return { captureState, microphoneStatus, startCapture, cancelCapture };
}
