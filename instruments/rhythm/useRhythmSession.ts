import { useCallback, useRef, useState } from 'react';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { createClickBuffer } from '@/core/audio/clickBuffer';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import { createStreamingOnsetDetector } from '@/processing/dsp/onsets';

import {
  analyzeFreeClapping,
  type ContinuationScore,
  findCountInGrid,
  type FreeClappingAnalysis,
  scoreContinuation,
} from './rhythmAnalysis';

export const countInClickCount = 8;
export const continuationBeatCount = 16;
/** Margen entre programar los clics y que suene el primero. */
const schedulingLeadSeconds = 0.6;
/** Tiempo extra tras el último pulso para recoger la última palmada. */
const trailingMarginSeconds = 1;
const progressIntervalMilliseconds = 100;
/** Palmadas recientes con las que se analiza el modo libre. */
const freeClappingHistoryLength = 16;
/** ~5 ms de resolución a 48 kHz; la trama de 1024 muestras (~21 ms) cabe en una palmada. */
const detectorFrameSize = 1024;
const detectorHopSize = 256;
const clickAmplitude = 0.9;

export type RhythmMode = 'continuation' | 'free';

export type RhythmSessionState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'countIn'; beatNumber: number }
  | { phase: 'continuation'; beatNumber: number }
  | { phase: 'results'; continuationScore: ContinuationScore; targetBeatsPerMinute: number }
  | { phase: 'clicksNotHeard' }
  | { phase: 'freeListening'; analysis: FreeClappingAnalysis | null; clapCount: number }
  | { phase: 'error'; errorMessage: string };

interface ActiveSession {
  audioContext: AudioContext;
  audioRecorder: AudioRecorder;
  timeouts: ReturnType<typeof setTimeout>[];
  intervals: ReturnType<typeof setInterval>[];
}

/**
 * Sesión de ritmo: graba el micrófono en bloques continuos (sin guardarlo), detecta golpes y,
 * en «Mantén el pulso», programa los clics de entrada en el reloj de audio. Todo se cierra al
 * terminar, al salir de la pantalla o al pasar la app a segundo plano.
 */
export function useRhythmSession() {
  const [sessionState, setSessionState] = useState<RhythmSessionState>({ phase: 'idle' });
  const activeSessionRef = useRef<ActiveSession | null>(null);

  const stopSession = useCallback(() => {
    const activeSession = activeSessionRef.current;
    if (!activeSession) return;
    activeSessionRef.current = null;
    activeSession.timeouts.forEach((timeout) => clearTimeout(timeout));
    activeSession.intervals.forEach((interval) => clearInterval(interval));
    activeSession.audioRecorder.clearOnAudioReady();
    void activeSession.audioRecorder.stop().catch(() => undefined);
    void activeSession.audioContext.close().catch(() => undefined);
  }, []);

  const cancel = useCallback(() => {
    stopSession();
    setSessionState({ phase: 'idle' });
  }, [stopSession]);

  // Al pasar a segundo plano se vuelve al inicio y se cierra el audio.
  useStopWhenAppInactive(() => setSessionState({ phase: 'idle' }), stopSession);

  const start = useCallback(
    async (mode: RhythmMode, targetBeatsPerMinute: number) => {
      stopSession();
      setSessionState({ phase: 'starting' });
      const audioContext = new AudioContext();
      const audioRecorder = new AudioRecorder();
      const activeSession: ActiveSession = { audioContext, audioRecorder, timeouts: [], intervals: [] };
      activeSessionRef.current = activeSession;
      const isCurrentSession = () => activeSessionRef.current === activeSession;

      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'measurement', iosOptions: [] });
        const onsetTimesSeconds: number[] = [];
        let onsetDetector: ReturnType<typeof createStreamingOnsetDetector> | null = null;
        let inputSampleRateHz = 0;
        let receivedSampleCount = 0;
        let resolveFirstBuffer: () => void = () => undefined;
        const firstBufferArrived = new Promise<void>((resolve) => (resolveFirstBuffer = resolve));

        audioRecorder.onAudioReady(
          { sampleRate: audioContext.sampleRate, bufferLength: 1024, channelCount: 1 },
          (audioEvent) => {
            if (!isCurrentSession()) return;
            if (!onsetDetector) {
              inputSampleRateHz = audioEvent.buffer.sampleRate;
              onsetDetector = createStreamingOnsetDetector({
                sampleRateHz: inputSampleRateHz,
                frameSize: detectorFrameSize,
                hopSize: detectorHopSize,
              });
              resolveFirstBuffer();
            }
            receivedSampleCount += audioEvent.numFrames;
            const newOnsets = onsetDetector.pushSamples(audioEvent.buffer.getChannelData(0));
            if (newOnsets.length === 0) return;
            onsetTimesSeconds.push(...newOnsets);
            if (mode === 'free') {
              const recentClaps = onsetTimesSeconds.slice(-freeClappingHistoryLength);
              setSessionState({
                phase: 'freeListening',
                analysis: analyzeFreeClapping(recentClaps),
                clapCount: onsetTimesSeconds.length,
              });
            }
          },
        );

        const startResult = await audioRecorder.start();
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();
        await firstBufferArrived;
        if (!isCurrentSession()) return;

        if (mode === 'free') {
          setSessionState({ phase: 'freeListening', analysis: null, clapCount: 0 });
          return;
        }

        const periodSeconds = 60 / targetBeatsPerMinute;
        const firstClickContextSeconds = audioContext.currentTime + schedulingLeadSeconds;
        // Posición aproximada del primer clic en la línea del micrófono. La latencia real se
        // descubre al encontrar los clics en la grabación.
        const expectedFirstClickSeconds = receivedSampleCount / inputSampleRateHz + schedulingLeadSeconds;
        const accentClick = createClickBuffer(audioContext, true, clickAmplitude);
        const regularClick = createClickBuffer(audioContext, false, clickAmplitude);
        for (let clickIndex = 0; clickIndex < countInClickCount; clickIndex++) {
          const clickSource = audioContext.createBufferSource();
          clickSource.buffer = clickIndex % 4 === 0 ? accentClick : regularClick;
          clickSource.connect(audioContext.destination);
          clickSource.start(firstClickContextSeconds + clickIndex * periodSeconds);
        }

        const totalBeatCount = countInClickCount + continuationBeatCount;
        const progressTimer = setInterval(() => {
          if (!isCurrentSession()) return;
          const elapsedBeats = Math.floor((audioContext.currentTime - firstClickContextSeconds) / periodSeconds);
          if (elapsedBeats < 0) return;
          if (elapsedBeats < countInClickCount) {
            setSessionState({ phase: 'countIn', beatNumber: elapsedBeats + 1 });
          } else if (elapsedBeats < totalBeatCount) {
            setSessionState({ phase: 'continuation', beatNumber: elapsedBeats - countInClickCount + 1 });
          }
        }, progressIntervalMilliseconds);
        activeSession.intervals.push(progressTimer);

        const sessionDurationMilliseconds =
          (schedulingLeadSeconds + totalBeatCount * periodSeconds + trailingMarginSeconds) * 1000;
        activeSession.timeouts.push(
          setTimeout(() => {
            if (!isCurrentSession()) return;
            stopSession();
            const countIn = findCountInGrid(onsetTimesSeconds, {
              nominalPeriodSeconds: periodSeconds,
              clickCount: countInClickCount,
              expectedFirstClickSeconds,
            });
            if (!countIn) {
              setSessionState({ phase: 'clicksNotHeard' });
              return;
            }
            const clapTimesSeconds = onsetTimesSeconds.filter(
              (onsetTimeSeconds) => onsetTimeSeconds > countIn.lastClickSeconds + periodSeconds / 2,
            );
            setSessionState({
              phase: 'results',
              continuationScore: scoreContinuation(clapTimesSeconds, countIn.beatGrid, {
                firstBeatIndex: countInClickCount,
                beatCount: continuationBeatCount,
              }),
              targetBeatsPerMinute,
            });
          }, sessionDurationMilliseconds),
        );
      } catch (startError) {
        if (isCurrentSession()) {
          stopSession();
          setSessionState({ phase: 'error', errorMessage: String(startError) });
        }
      }
    },
    [stopSession],
  );

  return { sessionState, start, cancel };
}
