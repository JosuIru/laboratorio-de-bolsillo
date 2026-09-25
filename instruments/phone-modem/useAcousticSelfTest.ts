import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { startRecorderInOrder, stopRecorderInOrder } from '@/core/audio/recorderQueue';
import { useIsScreenActive } from '@/core/useIsScreenActive';
import {
  type AcousticBandPreset,
  acousticConfigurationFor,
  type AcousticReceiver,
  type AcousticReceiverEvent,
  createAcousticReceiver,
  isAcousticConfigurationSupported,
  modulateAcousticFrame,
} from '@/processing/modem/acousticModem';
import { decodeMessage, prepareMessage } from '@/processing/modem/frameCodec';

import { acousticBandOptions, acousticVolume, errorCorrectionByChannel } from './modemConfiguration';

const selfTestText = 'PRUEBA 123';
const selfTestSpeed = 'normal';
const settleMilliseconds = 500;
const trailingListenMilliseconds = 500;

export type SelfTestOutcome = 'received' | 'damaged' | 'notHeard' | 'unsupported';

export interface SelfTestBandResult {
  bandPreset: AcousticBandPreset;
  outcome: SelfTestOutcome;
  /** 0-1, si se oyó el preámbulo. */
  qualityScore: number | null;
}

export type SelfTestState =
  | { phase: 'idle' }
  | { phase: 'running'; currentBand: AcousticBandPreset }
  | { phase: 'done'; bandResults: SelfTestBandResult[]; recommendedBand: AcousticBandPreset | null }
  | { phase: 'error'; errorMessage: string };

function waitMilliseconds(durationMilliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

/** Resume lo que oyó el receptor durante la prueba de una banda. */
function summarizeBandEvents(bandPreset: AcousticBandPreset, receiverEvents: AcousticReceiverEvent[]): SelfTestBandResult {
  for (const receiverEvent of receiverEvents) {
    if (receiverEvent.type !== 'frameReceived') continue;
    const isIntact =
      receiverEvent.frame.isCrcValid && decodeMessage(receiverEvent.frame).text === selfTestText;
    return {
      bandPreset,
      outcome: isIntact ? 'received' : 'damaged',
      qualityScore: receiverEvent.linkQuality.qualityScore,
    };
  }
  const lostEvent = receiverEvents.find((receiverEvent) => receiverEvent.type === 'frameLost');
  if (lostEvent?.type === 'frameLost') {
    return { bandPreset, outcome: 'damaged', qualityScore: lostEvent.linkQuality.qualityScore };
  }
  return { bandPreset, outcome: 'notHeard', qualityScore: null };
}

/**
 * Autoprueba: el móvil se envía un mensaje a sí mismo (altavoz → su propio micrófono) en cada
 * banda. Si en la casi ultrasónica no llega, el altavoz o el micrófono cortan antes de 18 kHz
 * y hay que usar la audible. Es lo mismo que la prueba de hardware del sonar, pero de extremo
 * a extremo: comprueba también el módem.
 */
export function useAcousticSelfTest() {
  const isScreenActive = useIsScreenActive();
  const [selfTestState, setSelfTestState] = useState<SelfTestState>({ phase: 'idle' });
  const releaseRef = useRef<(() => void) | null>(null);

  const stopAudio = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const cancelSelfTest = useCallback(() => {
    stopAudio();
    setSelfTestState({ phase: 'idle' });
  }, [stopAudio]);

  // Al pasar a segundo plano o al taparla otra pantalla se corta la prueba: el estado se ajusta
  // durante el render y el efecto solo libera el audio.
  const [wasScreenActive, setWasScreenActive] = useState(isScreenActive);
  if (wasScreenActive !== isScreenActive) {
    setWasScreenActive(isScreenActive);
    if (!isScreenActive && selfTestState.phase === 'running') setSelfTestState({ phase: 'idle' });
  }
  useEffect(() => {
    if (!isScreenActive) stopAudio();
  }, [isScreenActive, stopAudio]);
  useEffect(() => stopAudio, [stopAudio]);

  const runSelfTest = useCallback(async () => {
    stopAudio();
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    let isReleased = false;
    const release = () => {
      if (isReleased) return;
      isReleased = true;
      audioRecorder.clearOnAudioReady();
      void stopRecorderInOrder(audioRecorder);
      void audioContext.close().catch(() => undefined);
    };
    releaseRef.current = release;

    let inputSampleRateHz: number | null = null;
    let activeReceiver: AcousticReceiver | null = null;
    const collectedEvents: AcousticReceiverEvent[] = [];

    try {
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
        iosMode: 'measurement',
        iosOptions: ['defaultToSpeaker'],
      });
      setSelfTestState({ phase: 'running', currentBand: acousticBandOptions[0]! });
      const outputSampleRateHz = audioContext.sampleRate;
      audioRecorder.onAudioReady({ sampleRate: outputSampleRateHz, bufferLength: 2048, channelCount: 1 }, (audioEvent) => {
        if (isReleased) return;
        inputSampleRateHz ??= audioEvent.buffer.sampleRate;
        if (activeReceiver) collectedEvents.push(...activeReceiver.pushSamples(audioEvent.buffer.getChannelData(0)));
      });
      const startResult = await startRecorderInOrder(audioRecorder, () => isReleased);
      if (!startResult) return;
      if (startResult.status === 'error') throw new Error(startResult.message);
      await audioContext.resume();
      await waitMilliseconds(settleMilliseconds);
      if (isReleased) return;
      if (inputSampleRateHz === null) throw new Error('El micrófono no entrega sonido');

      const errorCorrection = errorCorrectionByChannel.sound;
      const channelBits = prepareMessage({ text: selfTestText }, errorCorrection).channelBits;
      const bandResults: SelfTestBandResult[] = [];
      for (const bandPreset of acousticBandOptions) {
        setSelfTestState({ phase: 'running', currentBand: bandPreset });
        const configuration = acousticConfigurationFor(bandPreset, selfTestSpeed);
        if (
          !isAcousticConfigurationSupported(configuration, outputSampleRateHz) ||
          !isAcousticConfigurationSupported(configuration, inputSampleRateHz)
        ) {
          bandResults.push({ bandPreset, outcome: 'unsupported', qualityScore: null });
          continue;
        }
        collectedEvents.length = 0;
        activeReceiver = createAcousticReceiver({ sampleRateHz: inputSampleRateHz, configuration, errorCorrection });
        const frameSamples = modulateAcousticFrame(channelBits, configuration, outputSampleRateHz);
        const frameBuffer = audioContext.createBuffer(1, frameSamples.length, outputSampleRateHz);
        frameBuffer.copyToChannel(frameSamples, 0);
        const frameSource = audioContext.createBufferSource();
        frameSource.buffer = frameBuffer;
        const gainNode = audioContext.createGain();
        gainNode.gain.value = acousticVolume;
        frameSource.connect(gainNode);
        gainNode.connect(audioContext.destination);
        frameSource.start();
        await waitMilliseconds((frameSamples.length / outputSampleRateHz) * 1000 + trailingListenMilliseconds);
        if (isReleased) return;
        activeReceiver = null;
        bandResults.push(summarizeBandEvents(bandPreset, collectedEvents));
      }
      release();
      if (releaseRef.current === release) releaseRef.current = null;
      const recommendedBand =
        bandResults.find((bandResult) => bandResult.outcome === 'received')?.bandPreset ?? null;
      setSelfTestState({ phase: 'done', bandResults, recommendedBand });
    } catch (selfTestError) {
      if (!isReleased) {
        release();
        setSelfTestState({ phase: 'error', errorMessage: String(selfTestError) });
      }
    }
  }, [stopAudio]);

  return { selfTestState, runSelfTest, cancelSelfTest };
}
