import { useCallback, useRef, useState } from 'react';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';

import { createImpulseCapture, type ImpulseCapturePhase } from './impulseCapture';
import { analyzeRoomResponse, type BandReverberation } from './reverberationAnalysis';

export interface RoomMeasurementResult {
  bandResults: BandReverberation[];
  noiseLevelDecibels: number;
  isClipped: boolean;
  sampleRateHz: number;
}

export type RoomMeasurementState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'warming-up' | 'measuring-noise' | 'waiting-for-impulse' | 'recording-decay' }
  | { phase: 'analyzing' }
  | { phase: 'done'; result: RoomMeasurementResult }
  | { phase: 'error'; reason: 'no-impulse' | 'microphone'; message?: string };

interface ActiveSession {
  audioContext: AudioContext;
  audioRecorder: AudioRecorder;
}

/** Micrófono → captura del golpe → análisis por bandas. Una medición por cada `start()`. */
export function useRoomMeasurement() {
  const [measurementState, setMeasurementState] = useState<RoomMeasurementState>({ phase: 'idle' });
  const activeSessionRef = useRef<ActiveSession | null>(null);
  /** Cambia al empezar, cancelar o salir: un análisis pendiente de otra medición no pinta nada. */
  const measurementIdRef = useRef(0);

  const stopSession = useCallback(() => {
    const activeSession = activeSessionRef.current;
    if (!activeSession) return;
    activeSessionRef.current = null;
    activeSession.audioRecorder.clearOnAudioReady();
    void activeSession.audioRecorder.stop().catch(() => undefined);
    void activeSession.audioContext.close().catch(() => undefined);
  }, []);

  const abandonMeasurement = useCallback(() => {
    measurementIdRef.current++;
    stopSession();
  }, [stopSession]);

  const cancel = useCallback(() => {
    abandonMeasurement();
    setMeasurementState({ phase: 'idle' });
  }, [abandonMeasurement]);

  useStopWhenAppInactive(() => setMeasurementState({ phase: 'idle' }), abandonMeasurement);

  const start = useCallback(async () => {
    stopSession();
    const measurementId = ++measurementIdRef.current;
    setMeasurementState({ phase: 'starting' });
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    const activeSession: ActiveSession = { audioContext, audioRecorder };
    activeSessionRef.current = activeSession;
    const isCurrentSession = () => activeSessionRef.current === activeSession;

    try {
      AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'measurement', iosOptions: [] });
      let impulseCapture: ReturnType<typeof createImpulseCapture> | null = null;
      let inputSampleRateHz = 0;
      let reportedPhase: ImpulseCapturePhase | null = null;

      audioRecorder.onAudioReady(
        { sampleRate: audioContext.sampleRate, bufferLength: 1024, channelCount: 1 },
        (audioEvent) => {
          if (!isCurrentSession()) return;
          if (!impulseCapture) {
            inputSampleRateHz = audioEvent.buffer.sampleRate;
            impulseCapture = createImpulseCapture({ sampleRateHz: inputSampleRateHz });
          }
          const capturePhase = impulseCapture.pushBlock(audioEvent.buffer.getChannelData(0));
          if (capturePhase === reportedPhase) return;
          reportedPhase = capturePhase;

          if (capturePhase === 'timed-out') {
            stopSession();
            setMeasurementState({ phase: 'error', reason: 'no-impulse' });
            return;
          }
          if (capturePhase !== 'finished') {
            setMeasurementState({ phase: capturePhase });
            return;
          }
          const capturedResponse = impulseCapture.capturedResponse!;
          stopSession();
          setMeasurementState({ phase: 'analyzing' });
          // Se deja pintar «Analizando…» antes del cálculo (unas décimas de segundo).
          setTimeout(() => {
            if (measurementIdRef.current !== measurementId) return;
            const bandResults = analyzeRoomResponse(
              capturedResponse.responseSamples,
              capturedResponse.noiseSamples,
              inputSampleRateHz,
            );
            setMeasurementState({
              phase: 'done',
              result: {
                bandResults,
                noiseLevelDecibels: capturedResponse.noiseLevelDecibels,
                isClipped: capturedResponse.isClipped,
                sampleRateHz: inputSampleRateHz,
              },
            });
          }, 50);
        },
      );

      const startResult = await audioRecorder.start();
      // Si se canceló (o la app pasó a segundo plano, p. ej. por el aviso de permiso) mientras
      // arrancaba, este grabador ya no es de nadie: hay que pararlo aquí o se queda encendido.
      if (!isCurrentSession()) {
        audioRecorder.clearOnAudioReady();
        void audioRecorder.stop().catch(() => undefined);
        void audioContext.close().catch(() => undefined);
        return;
      }
      if (startResult.status === 'error') throw new Error(startResult.message);
      await audioContext.resume();
    } catch (startError) {
      if (!isCurrentSession()) return;
      stopSession();
      setMeasurementState({ phase: 'error', reason: 'microphone', message: String(startError) });
    }
  }, [stopSession]);

  return { measurementState, start, cancel };
}
