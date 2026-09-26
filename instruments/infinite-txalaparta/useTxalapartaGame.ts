import { useCallback, useRef, useState } from 'react';
import { type AudioBuffer, AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';

import { startRecorderInOrder, stopRecorderInOrder } from '@/core/audio/recorderQueue';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import { createStreamingOnsetDetector } from '@/processing/dsp/onsets';
import { generateNoise } from '@/processing/dsp/signalGenerator';

import { findCountInGrid } from '@instruments/rhythm/rhythmAnalysis';

import {
  addJudgement,
  beatsPerMinuteForBar,
  detectStrayStroke,
  eighthSeconds,
  emptyTally,
  type GameTally,
  generateBar,
  judgePlayerSlot,
  levelForBar,
  machineStrokeSeconds,
  type SlotJudgement,
  type SlotOwner,
  slotsPerBar,
  startBeatsPerMinute,
  strayJudgement,
  toleranceForTempo,
} from './txalapartaGame';

const countInStrokeCount = 4;
/** Margen entre programar la cuenta de entrada y que suene el primer golpe. */
const schedulingLeadSeconds = 0.6;
const schedulerIntervalMilliseconds = 50;
const scheduleAheadSeconds = 0.3;
/** También marca el ritmo al que se repinta el compás en pantalla. */
const judgeIntervalMilliseconds = 50;
/** Margen tras la ventana de una palmada antes de juzgarla (el detector va algo retrasado). */
const judgingDelaySeconds = 0.12;
/** Golpes y tiempos que se conservan para juzgar: los de más atrás ya no hacen falta. */
const historySeconds = 8;
const detectorFrameSize = 1024;
const detectorHopSize = 256;
const strokeVolume = 0.9;

export type TxalapartaState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | {
      phase: 'playing';
      isCountIn: boolean;
      tally: GameTally;
      barIndex: number;
      beatsPerMinute: number;
      level: number;
      lastJudgement: SlotJudgement | null;
      /** El compás que suena ahora, para pintarlo (vacío durante la entrada). */
      currentBarSlots: SlotOwner[];
      /** Corchea que suena ahora dentro de `currentBarSlots`, o null si aún no ha empezado. */
      currentSlotIndex: number | null;
    }
  | { phase: 'over'; tally: GameTally; barIndex: number; beatsPerMinute: number }
  | { phase: 'strokes-not-heard' }
  | { phase: 'error'; errorMessage: string };

interface ActiveSession {
  audioContext: AudioContext;
  audioRecorder: AudioRecorder;
  intervals: ReturnType<typeof setInterval>[];
}

/**
 * Golpe de madera (una tabla de txalaparta): senoidal amortiguada con un chasquido de ruido.
 * Dos tablas con alturas distintas para que se oiga la alternancia.
 */
function createWoodStrokeBuffer(audioContext: AudioContext, frequencyHz: number): AudioBuffer {
  const sampleRateHz = audioContext.sampleRate;
  const strokeSamples = new Float32Array(Math.round(machineStrokeSeconds * sampleRateHz));
  const clickNoise = generateNoise({ sampleRateHz, durationSeconds: 0.01, amplitude: 0.4, seed: Math.round(frequencyHz) });
  for (let sampleIndex = 0; sampleIndex < strokeSamples.length; sampleIndex++) {
    const elapsedSeconds = sampleIndex / sampleRateHz;
    const body = Math.sin(2 * Math.PI * frequencyHz * elapsedSeconds) * Math.exp(-elapsedSeconds / 0.03);
    const overtone = 0.35 * Math.sin(2 * Math.PI * frequencyHz * 2.7 * elapsedSeconds) * Math.exp(-elapsedSeconds / 0.012);
    strokeSamples[sampleIndex] = strokeVolume * (body + overtone) + (clickNoise[sampleIndex] ?? 0);
  }
  const strokeBuffer = audioContext.createBuffer(1, strokeSamples.length, sampleRateHz);
  strokeBuffer.copyToChannel(new Float32Array(strokeSamples), 0);
  return strokeBuffer;
}

/**
 * Partida de txalaparta sin fin: el móvil toca su parte por el altavoz y escucha las palmadas
 * por el micrófono. La cuenta de entrada sirve para saber cuánto tarda en llegar al micrófono lo
 * que suena por el altavoz; con eso se sabe dónde debería oírse cada palmada.
 */
export function useTxalapartaGame() {
  const [gameState, setGameState] = useState<TxalapartaState>({ phase: 'idle' });
  const activeSessionRef = useRef<ActiveSession | null>(null);

  const stopSession = useCallback(() => {
    const activeSession = activeSessionRef.current;
    if (!activeSession) return;
    activeSessionRef.current = null;
    activeSession.intervals.forEach((interval) => clearInterval(interval));
    activeSession.audioRecorder.clearOnAudioReady();
    void stopRecorderInOrder(activeSession.audioRecorder);
    void activeSession.audioContext.close().catch(() => undefined);
  }, []);

  const cancel = useCallback(() => {
    stopSession();
    setGameState({ phase: 'idle' });
  }, [stopSession]);

  // Al salir de la pantalla o de la app se corta la partida (una terminada se conserva).
  useStopWhenAppInactive(
    () => setGameState((previousState) => (previousState.phase === 'over' ? previousState : { phase: 'idle' })),
    stopSession,
  );

  const start = useCallback(async () => {
    stopSession();
    setGameState({ phase: 'starting' });
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    const activeSession: ActiveSession = { audioContext, audioRecorder, intervals: [] };
    activeSessionRef.current = activeSession;
    const isCurrentSession = () => activeSessionRef.current === activeSession;
    const seed = Math.floor(Math.random() * 1_000_000);

    try {
      AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'measurement', iosOptions: [] });
      let onsetTimesSeconds: number[] = [];
      let onsetDetector: ReturnType<typeof createStreamingOnsetDetector> | null = null;
      let inputSampleRateHz = 0;
      let receivedSampleCount = 0;
      let resolveFirstBuffer: () => void = () => undefined;
      const firstBufferArrived = new Promise<void>((resolve) => (resolveFirstBuffer = resolve));

      audioRecorder.onAudioReady({ sampleRate: audioContext.sampleRate, bufferLength: 1024, channelCount: 1 }, (audioEvent) => {
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
        onsetTimesSeconds.push(...onsetDetector.pushSamples(audioEvent.buffer.getChannelData(0)));
      });

      // La cola espera a que otros grabadores se paren y, si se cancela, deja este parado.
      const startResult = await startRecorderInOrder(audioRecorder, () => !isCurrentSession());
      if (!startResult || !isCurrentSession()) return;
      if (startResult.status === 'error') throw new Error(startResult.message);
      await audioContext.resume();
      await firstBufferArrived;
      if (!isCurrentSession()) return;

      const strokeBuffers = [createWoodStrokeBuffer(audioContext, 620), createWoodStrokeBuffer(audioContext, 830)];
      let strokeCount = 0;
      const machineContextTimes: number[] = [];
      function playStroke(contextSeconds: number) {
        const strokeSource = audioContext.createBufferSource();
        strokeSource.buffer = strokeBuffers[strokeCount++ % strokeBuffers.length]!;
        strokeSource.connect(audioContext.destination);
        strokeSource.start(contextSeconds);
        machineContextTimes.push(contextSeconds);
      }

      // Cuenta de entrada: cuatro golpes a negras.
      const quarterSeconds = 60 / startBeatsPerMinute;
      const firstStrokeContextSeconds = audioContext.currentTime + schedulingLeadSeconds;
      const expectedFirstStrokeMicrophoneSeconds = receivedSampleCount / inputSampleRateHz + schedulingLeadSeconds;
      for (let strokeIndex = 0; strokeIndex < countInStrokeCount; strokeIndex++) {
        playStroke(firstStrokeContextSeconds + strokeIndex * quarterSeconds);
      }
      const countInEndContextSeconds = firstStrokeContextSeconds + countInStrokeCount * quarterSeconds;

      // Corcheas programadas y aún sin juzgar: cuándo suenan (reloj de audio) y de quién son. Las
      // del jugador se juzgan como acierto o fallo; las demás, por si hubo un golpe fuera de sitio.
      const scheduledSlots: { contextSeconds: number; beatsPerMinute: number; slotOwner: SlotOwner }[] = [];
      // Compases ya programados, con el instante en que empiezan, para pintar el que suena.
      const scheduledBars: { contextSeconds: number; slotSeconds: number; barSlots: SlotOwner[] }[] = [];
      let barIndex = 0;
      let slotIndex = 0;
      let barSlots: SlotOwner[] = generateBar(0, seed);
      let nextSlotContextSeconds = countInEndContextSeconds;
      let contextToMicrophoneOffsetSeconds: number | null = null;
      let gameTally = emptyTally;
      let lastJudgement: SlotJudgement | null = null;

      const publishState = () => {
        const beatsPerMinute = beatsPerMinuteForBar(barIndex);
        const currentTime = audioContext.currentTime;
        while (scheduledBars.length > 1 && scheduledBars[1]!.contextSeconds <= currentTime) scheduledBars.shift();
        const soundingBar = scheduledBars[0];
        let currentSlotIndex: number | null = null;
        if (soundingBar && soundingBar.contextSeconds <= currentTime) {
          currentSlotIndex = Math.min(
            slotsPerBar - 1,
            Math.floor((currentTime - soundingBar.contextSeconds) / soundingBar.slotSeconds),
          );
        }
        setGameState({
          phase: 'playing',
          isCountIn: audioContext.currentTime < countInEndContextSeconds,
          tally: gameTally,
          barIndex,
          beatsPerMinute,
          level: levelForBar(barIndex),
          lastJudgement,
          currentBarSlots: soundingBar && currentSlotIndex !== null ? soundingBar.barSlots : [],
          currentSlotIndex,
        });
      };

      activeSession.intervals.push(
        setInterval(() => {
          if (!isCurrentSession()) return;
          while (nextSlotContextSeconds < audioContext.currentTime + scheduleAheadSeconds) {
            const beatsPerMinute = beatsPerMinuteForBar(barIndex);
            const slotOwner = barSlots[slotIndex]!;
            if (slotIndex === 0) {
              scheduledBars.push({ contextSeconds: nextSlotContextSeconds, slotSeconds: eighthSeconds(beatsPerMinute), barSlots });
            }
            if (slotOwner === 'machine') playStroke(nextSlotContextSeconds);
            scheduledSlots.push({ contextSeconds: nextSlotContextSeconds, beatsPerMinute, slotOwner });
            nextSlotContextSeconds += eighthSeconds(beatsPerMinute);
            slotIndex++;
            if (slotIndex >= slotsPerBar) {
              slotIndex = 0;
              barIndex++;
              barSlots = generateBar(barIndex, seed);
            }
          }
        }, schedulerIntervalMilliseconds),
      );

      activeSession.intervals.push(
        setInterval(() => {
          if (!isCurrentSession()) return;
          const latestMicrophoneSeconds = receivedSampleCount / inputSampleRateHz;

          if (contextToMicrophoneOffsetSeconds === null) {
            if (audioContext.currentTime < countInEndContextSeconds + 0.3) {
              publishState();
              return;
            }
            const countIn = findCountInGrid(onsetTimesSeconds, {
              nominalPeriodSeconds: quarterSeconds,
              clickCount: countInStrokeCount,
              expectedFirstClickSeconds: expectedFirstStrokeMicrophoneSeconds,
              minimumMatchedClicks: countInStrokeCount - 1,
            });
            if (!countIn) {
              stopSession();
              setGameState({ phase: 'strokes-not-heard' });
              return;
            }
            contextToMicrophoneOffsetSeconds = countIn.beatGrid.firstBeatSeconds - firstStrokeContextSeconds;
          }

          const machineMicrophoneTimes = machineContextTimes.map(
            (contextSeconds) => contextSeconds + contextToMicrophoneOffsetSeconds!,
          );
          while (scheduledSlots.length > 0) {
            const scheduledSlot = scheduledSlots[0]!;
            const toleranceSeconds = toleranceForTempo(scheduledSlot.beatsPerMinute);
            const expectedMicrophoneSeconds = scheduledSlot.contextSeconds + contextToMicrophoneOffsetSeconds;
            if (expectedMicrophoneSeconds + toleranceSeconds + judgingDelaySeconds > latestMicrophoneSeconds) break;
            scheduledSlots.shift();
            if (scheduledSlot.slotOwner === 'player') {
              lastJudgement = judgePlayerSlot(expectedMicrophoneSeconds, onsetTimesSeconds, machineMicrophoneTimes, toleranceSeconds);
            } else if (detectStrayStroke(expectedMicrophoneSeconds, onsetTimesSeconds, machineMicrophoneTimes, toleranceSeconds)) {
              lastJudgement = strayJudgement;
            } else {
              continue;
            }
            gameTally = addJudgement(gameTally, lastJudgement);
            if (gameTally.isOver) {
              stopSession();
              setGameState({ phase: 'over', tally: gameTally, barIndex, beatsPerMinute: beatsPerMinuteForBar(barIndex) });
              return;
            }
          }
          // Lo muy antiguo ya no se necesita para juzgar.
          onsetTimesSeconds = onsetTimesSeconds.filter((onsetSeconds) => onsetSeconds > latestMicrophoneSeconds - historySeconds);
          while (machineContextTimes.length > 0 && machineContextTimes[0]! < audioContext.currentTime - historySeconds) {
            machineContextTimes.shift();
          }
          publishState();
        }, judgeIntervalMilliseconds),
      );
    } catch (startError) {
      if (isCurrentSession()) {
        stopSession();
        setGameState({ phase: 'error', errorMessage: String(startError) });
      }
    }
  }, [stopSession]);

  return { gameState, start, cancel };
}
