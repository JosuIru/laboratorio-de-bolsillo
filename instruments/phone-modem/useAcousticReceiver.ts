import { useEffect, useRef, useState } from 'react';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { startRecorderInOrder, stopRecorderInOrder } from '@/core/audio/recorderQueue';
import { useIsScreenActive } from '@/core/useIsScreenActive';
import {
  type AcousticBandPreset,
  acousticConfigurationFor,
  type AcousticReceiver,
  type AcousticReceiverEvent,
  type AcousticReceiverStatus,
  type AcousticSpeedPreset,
  createAcousticReceiver,
  isAcousticConfigurationSupported,
} from '@/processing/modem/acousticModem';
import type { ErrorCorrection } from '@/processing/modem/frameCodec';


export type AcousticListenerState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'listening'; sampleRateHz: number }
  | { status: 'sampleRateTooLow'; sampleRateHz: number }
  | { status: 'error'; errorMessage: string };

const statusUpdateMilliseconds = 150;

interface AcousticReceiverOptions {
  isListening: boolean;
  bandPreset: AcousticBandPreset;
  speedPreset: AcousticSpeedPreset;
  errorCorrection: ErrorCorrection;
  onReceiverEvent(receiverEvent: AcousticReceiverEvent): void;
}

/**
 * Escucha el micrófono y pasa las muestras al receptor acústico. Los sucesos (preámbulo,
 * trama recibida o perdida) llegan por `onReceiverEvent`; el estado se refresca unas 7 veces
 * por segundo. Se para al pausar, al salir de la pantalla o al pasar la app a segundo plano.
 */
export function useAcousticReceiver({
  isListening,
  bandPreset,
  speedPreset,
  errorCorrection,
  onReceiverEvent,
}: AcousticReceiverOptions) {
  const isScreenActive = useIsScreenActive();
  const shouldListen = isListening && isScreenActive;
  const [listenerState, setListenerState] = useState<AcousticListenerState>({ status: 'idle' });
  const [receiverStatus, setReceiverStatus] = useState<AcousticReceiverStatus | null>(null);
  const onReceiverEventRef = useRef(onReceiverEvent);
  useEffect(() => {
    onReceiverEventRef.current = onReceiverEvent;
  }, [onReceiverEvent]);

  const listenKey = `${shouldListen}-${bandPreset}-${speedPreset}-${errorCorrection}`;
  const [currentListenKey, setCurrentListenKey] = useState<string | null>(null);
  if (currentListenKey !== listenKey) {
    setCurrentListenKey(listenKey);
    setListenerState(shouldListen ? { status: 'starting' } : { status: 'idle' });
    setReceiverStatus(null);
  }

  useEffect(() => {
    if (!shouldListen) return;
    let isCancelled = false;
    let statusTimer: ReturnType<typeof setInterval> | null = null;
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    let acousticReceiver: AcousticReceiver | null = null;
    const configuration = acousticConfigurationFor(bandPreset, speedPreset);

    function releaseAudio() {
      if (isCancelled) return;
      isCancelled = true;
      if (statusTimer) clearInterval(statusTimer);
      audioRecorder.clearOnAudioReady();
      void stopRecorderInOrder(audioRecorder);
      void audioContext.close().catch(() => undefined);
    }

    async function startListening() {
      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'measurement', iosOptions: [] });
        audioRecorder.onAudioReady(
          { sampleRate: audioContext.sampleRate, bufferLength: 2048, channelCount: 1 },
          (audioEvent) => {
            if (isCancelled) return;
            if (!acousticReceiver) {
              const inputSampleRateHz = audioEvent.buffer.sampleRate;
              if (!isAcousticConfigurationSupported(configuration, inputSampleRateHz)) {
                releaseAudio();
                setListenerState({ status: 'sampleRateTooLow', sampleRateHz: inputSampleRateHz });
                return;
              }
              acousticReceiver = createAcousticReceiver({
                sampleRateHz: inputSampleRateHz,
                configuration,
                errorCorrection,
              });
              setListenerState({ status: 'listening', sampleRateHz: inputSampleRateHz });
            }
            const receiverEvents = acousticReceiver.pushSamples(audioEvent.buffer.getChannelData(0));
            for (const receiverEvent of receiverEvents) onReceiverEventRef.current(receiverEvent);
          },
        );
        const startResult = await startRecorderInOrder(audioRecorder, () => isCancelled);
        if (!startResult || isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();
        statusTimer = setInterval(() => {
          if (acousticReceiver) setReceiverStatus(acousticReceiver.status);
        }, statusUpdateMilliseconds);
      } catch (startError) {
        if (!isCancelled) {
          releaseAudio();
          setListenerState({ status: 'error', errorMessage: String(startError) });
        }
      }
    }

    void startListening();
    return releaseAudio;
  }, [shouldListen, bandPreset, speedPreset, errorCorrection]);

  return { listenerState, receiverStatus };
}
