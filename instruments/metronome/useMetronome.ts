import { useCallback, useEffect, useRef, useState } from 'react';
import { type AudioBuffer, AudioContext, AudioManager } from 'react-native-audio-api';

import { useIsAppActive } from '@/core/useIsAppActive';
import { applyFadesInPlace, generateTone } from '@/processing/dsp/signalGenerator';

import { type BeatSchedulerPosition, type ScheduledBeat, scheduleBeatsUntil } from './metronomeTiming';

/** Cada cuánto se despierta el programador de pulsos. */
const schedulerIntervalMilliseconds = 25;
/**
 * Cuánto por delante se programan los pulsos en el reloj de audio. Tiene que cubrir de sobra
 * un retraso del hilo de JavaScript; los cambios de tempo tardan como mucho esto en notarse.
 */
const schedulingHorizonSeconds = 0.15;
/** Margen entre pulsar «Empezar» y el primer clic. */
const startDelaySeconds = 0.1;

export type MetronomeState =
  | { phase: 'idle' }
  /** `soundedBeatCount` sube con cada clic, para que la pantalla lo marque aunque el pulso no cambie. */
  | { phase: 'playing'; currentBeatInBar: number | null; soundedBeatCount: number }
  | { phase: 'error'; errorMessage: string };

/** Clic corto con rampas para que no suene a chasquido digital; el acento, más agudo. */
function createClickBuffer(audioContext: AudioContext, isAccent: boolean): AudioBuffer {
  const sampleRateHz = audioContext.sampleRate;
  const clickSamples = generateTone({
    frequencyHz: isAccent ? 1500 : 1000,
    sampleRateHz,
    durationSeconds: 0.03,
    amplitude: isAccent ? 0.95 : 0.75,
  });
  applyFadesInPlace(clickSamples, Math.round(0.002 * sampleRateHz));
  const clickBuffer = audioContext.createBuffer(1, clickSamples.length, sampleRateHz);
  // copyToChannel exige un Float32Array respaldado por un ArrayBuffer normal.
  clickBuffer.copyToChannel(new Float32Array(clickSamples), 0);
  return clickBuffer;
}

interface ActiveMetronome {
  audioContext: AudioContext;
  schedulerInterval: ReturnType<typeof setInterval>;
}

/**
 * Metrónomo: los clics se programan un poco por delante en el reloj de audio, que es preciso,
 * y el temporizador de JavaScript solo rellena la cola. Así el pulso no tiembla aunque el hilo
 * de la interfaz vaya cargado. Se para al salir de la pantalla o al pasar la app a segundo plano.
 */
export function useMetronome(beatsPerMinute: number, beatsPerBar: number) {
  const isAppActive = useIsAppActive();
  const [metronomeState, setMetronomeState] = useState<MetronomeState>({ phase: 'idle' });
  const activeMetronomeRef = useRef<ActiveMetronome | null>(null);
  // El programador lee el tempo y el compás actuales en cada vuelta, sin reiniciar el audio.
  const beatsPerMinuteRef = useRef(beatsPerMinute);
  const beatsPerBarRef = useRef(beatsPerBar);
  useEffect(() => {
    beatsPerMinuteRef.current = beatsPerMinute;
    beatsPerBarRef.current = beatsPerBar;
  }, [beatsPerMinute, beatsPerBar]);

  const stopAudio = useCallback(() => {
    const activeMetronome = activeMetronomeRef.current;
    if (!activeMetronome) return;
    activeMetronomeRef.current = null;
    clearInterval(activeMetronome.schedulerInterval);
    void activeMetronome.audioContext.close().catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    stopAudio();
    setMetronomeState({ phase: 'idle' });
  }, [stopAudio]);

  // Al pasar a segundo plano se para: el estado se ajusta durante el render (el patrón que
  // recomienda React) y el efecto solo cierra el audio.
  const [wasAppActive, setWasAppActive] = useState(isAppActive);
  if (wasAppActive !== isAppActive) {
    setWasAppActive(isAppActive);
    if (!isAppActive) setMetronomeState({ phase: 'idle' });
  }
  useEffect(() => {
    if (!isAppActive) stopAudio();
  }, [isAppActive, stopAudio]);
  useEffect(() => stopAudio, [stopAudio]);

  const start = useCallback(async () => {
    stopAudio();
    try {
      AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default', iosOptions: [] });
      const audioContext = new AudioContext();
      await audioContext.resume();
      const accentClick = createClickBuffer(audioContext, true);
      const regularClick = createClickBuffer(audioContext, false);
      let schedulerPosition: BeatSchedulerPosition = {
        nextBeatTimeSeconds: audioContext.currentTime + startDelaySeconds,
        nextBeatInBar: 0,
      };
      // Pulsos programados que aún no han sonado, para encender el indicador cuando suenen.
      const pendingBeats: ScheduledBeat[] = [];
      let soundedBeatCount = 0;

      const scheduleAndUpdateDisplay = () => {
        if (activeMetronomeRef.current?.audioContext !== audioContext) return;
        const { scheduledBeats, nextPosition } = scheduleBeatsUntil(
          schedulerPosition,
          audioContext.currentTime + schedulingHorizonSeconds,
          beatsPerMinuteRef.current,
          beatsPerBarRef.current,
        );
        schedulerPosition = nextPosition;
        for (const scheduledBeat of scheduledBeats) {
          const clickSource = audioContext.createBufferSource();
          clickSource.buffer = scheduledBeat.isAccent ? accentClick : regularClick;
          clickSource.connect(audioContext.destination);
          clickSource.start(scheduledBeat.timeSeconds);
          pendingBeats.push(scheduledBeat);
        }

        let soundedBeatInBar: number | null = null;
        while (pendingBeats.length > 0 && (pendingBeats[0]?.timeSeconds ?? Infinity) <= audioContext.currentTime) {
          soundedBeatInBar = pendingBeats.shift()?.beatInBar ?? null;
          soundedBeatCount += 1;
        }
        if (soundedBeatInBar !== null) {
          setMetronomeState({ phase: 'playing', currentBeatInBar: soundedBeatInBar, soundedBeatCount });
        }
      };

      activeMetronomeRef.current = {
        audioContext,
        schedulerInterval: setInterval(scheduleAndUpdateDisplay, schedulerIntervalMilliseconds),
      };
      setMetronomeState({ phase: 'playing', currentBeatInBar: null, soundedBeatCount: 0 });
      scheduleAndUpdateDisplay();
    } catch (startError) {
      stopAudio();
      setMetronomeState({ phase: 'error', errorMessage: String(startError) });
    }
  }, [stopAudio]);

  return { metronomeState, start, stop };
}
