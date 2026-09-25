import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { startRecorderInOrder, stopRecorderInOrder } from '@/core/audio/recorderQueue';
import { useIsScreenActive } from '@/core/useIsScreenActive';
import { type ClapTimingState, createClapTimingSession } from '@/processing/localization/clapTimingSession';
import { generateReferenceSequence } from '@/processing/localization/referenceSignal';

import { maximumAudioGapSeconds, recorderBufferLength } from './locatorConfiguration';

export type ClapTimingAudioStatus =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'listening'; sampleRateHz: number }
  | { status: 'error'; errorMessage: string };

type ClapTimingSession = ReturnType<typeof createClapTimingSession>;

const initialTimingState: ClapTimingState = { phase: 'waitingForChirp' };

/**
 * Micrófono en escucha continua para medir el intervalo «chirrido de referencia → palmada» en el
 * reloj de audio de este móvil, y altavoz para que el móvil emisor lance los dos chirridos.
 * Todo se para al desactivar la escucha, al salir de la pantalla o al pasar a segundo plano.
 */
export function useClapTiming(isListening: boolean) {
  const isScreenActive = useIsScreenActive();
  const shouldListen = isListening && isScreenActive;
  const [audioStatus, setAudioStatus] = useState<ClapTimingAudioStatus>({ status: 'idle' });
  const [timingState, setTimingState] = useState<ClapTimingState>(initialTimingState);
  const [isEmitting, setIsEmitting] = useState(false);

  const sessionRef = useRef<ClapTimingSession | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const [wasListening, setWasListening] = useState(shouldListen);
  if (wasListening !== shouldListen) {
    setWasListening(shouldListen);
    setAudioStatus(shouldListen ? { status: 'starting' } : { status: 'idle' });
    setTimingState(initialTimingState);
    setIsEmitting(false);
  }

  useEffect(() => {
    if (!shouldListen) return;
    let isCancelled = false;
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    let isAudioReleased = false;

    function releaseAudio() {
      isCancelled = true;
      if (isAudioReleased) return;
      isAudioReleased = true;
      audioContextRef.current = null;
      sessionRef.current = null;
      audioRecorder.clearOnAudioReady();
      void stopRecorderInOrder(audioRecorder);
      void audioContext.close().catch(() => undefined);
    }

    async function startListening() {
      try {
        AudioManager.setAudioSessionOptions({
          iosCategory: 'playAndRecord',
          iosMode: 'measurement',
          iosOptions: ['defaultToSpeaker'],
        });
        let inputSampleRateHz = 0;
        let receivedSampleCount = 0;
        let firstBufferWhenSeconds: number | null = null;

        audioRecorder.onAudioReady(
          { sampleRate: audioContext.sampleRate, bufferLength: recorderBufferLength, channelCount: 1 },
          (audioEvent) => {
            if (isCancelled) return;
            if (inputSampleRateHz === 0) {
              inputSampleRateHz = audioEvent.buffer.sampleRate;
              sessionRef.current = createClapTimingSession({ sampleRateHz: inputSampleRateHz });
              setAudioStatus({ status: 'listening', sampleRateHz: inputSampleRateHz });
            }
            const session = sessionRef.current;
            if (!session) return;
            // Si el micrófono se salta audio, los índices de muestra dejan de medir el tiempo.
            if (Number.isFinite(audioEvent.when)) {
              if (firstBufferWhenSeconds === null) firstBufferWhenSeconds = audioEvent.when;
              const expectedElapsedSeconds = receivedSampleCount / inputSampleRateHz;
              const reportedElapsedSeconds = audioEvent.when - firstBufferWhenSeconds;
              if (reportedElapsedSeconds - expectedElapsedSeconds > maximumAudioGapSeconds) {
                receivedSampleCount = Math.round(reportedElapsedSeconds * inputSampleRateHz);
                if (session.reportAudioGap()) setTimingState(session.getState());
              }
            }
            const channelSamples = audioEvent.buffer.getChannelData(0);
            receivedSampleCount += channelSamples.length;
            if (session.pushSamples(channelSamples)) setTimingState(session.getState());
          },
        );

        // La cola espera a que otros grabadores se paren y, si se cancela, deja este parado.
        const startResult = await startRecorderInOrder(audioRecorder, () => isCancelled);
        if (!startResult || isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();
        if (isCancelled) return;
        audioContextRef.current = audioContext;
      } catch (startError) {
        if (!isCancelled) setAudioStatus({ status: 'error', errorMessage: String(startError) });
      }
    }

    void startListening();
    return releaseAudio;
  }, [shouldListen]);

  /** Vuelve a esperar un chirrido nuevo sin cerrar el micrófono. */
  const restartMeasurement = useCallback(() => {
    const currentSession = sessionRef.current;
    if (!currentSession || audioStatus.status !== 'listening') return;
    sessionRef.current = createClapTimingSession({ sampleRateHz: audioStatus.sampleRateHz });
    setTimingState(initialTimingState);
  }, [audioStatus]);

  /** Este móvil hace de emisor: suenan los dos chirridos de referencia. */
  const emitReference = useCallback(() => {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;
    const referenceSequence = generateReferenceSequence(audioContext.sampleRate);
    const referenceBuffer = audioContext.createBuffer(1, referenceSequence.length, audioContext.sampleRate);
    // copyToChannel exige un Float32Array respaldado por un ArrayBuffer normal.
    referenceBuffer.copyToChannel(new Float32Array(referenceSequence), 0);
    const referenceSource = audioContext.createBufferSource();
    referenceSource.buffer = referenceBuffer;
    referenceSource.connect(audioContext.destination);
    referenceSource.onEnded = () => setIsEmitting(false);
    setIsEmitting(true);
    referenceSource.start();
    // Por si el aviso de final no llega (contexto cerrado a mitad): se libera el botón igualmente.
    setTimeout(() => setIsEmitting(false), (referenceSequence.length / audioContext.sampleRate) * 1000 + 500);
  }, []);

  return { audioStatus, timingState, isEmitting, restartMeasurement, emitReference };
}
