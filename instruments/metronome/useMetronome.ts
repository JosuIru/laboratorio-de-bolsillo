import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioContext, AudioManager } from 'react-native-audio-api';

import { createClickBuffer } from '@/core/audio/clickBuffer';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';

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
const accentClickAmplitude = 0.95;
const regularClickAmplitude = 0.75;

export type MetronomeState =
  | { phase: 'idle' }
  /** `soundedBeatCount` sube con cada clic, para que la pantalla lo marque aunque el pulso no cambie. */
  | { phase: 'playing'; currentBeatInBar: number | null; soundedBeatCount: number }
  | { phase: 'error'; errorMessage: string };

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
  const [metronomeState, setMetronomeState] = useState<MetronomeState>({ phase: 'idle' });
  const activeMetronomeRef = useRef<ActiveMetronome | null>(null);
  /**
   * Cambia en cada arranque y cada parada. Un arranque que vuelve de `await resume()` con otro
   * valor ya no vale (otro «Empezar», pantalla tapada o desmontada) y cierra su contexto.
   */
  const startTokenRef = useRef(0);
  // El programador lee el tempo y el compás actuales en cada vuelta, sin reiniciar el audio.
  const beatsPerMinuteRef = useRef(beatsPerMinute);
  const beatsPerBarRef = useRef(beatsPerBar);
  useEffect(() => {
    beatsPerMinuteRef.current = beatsPerMinute;
    beatsPerBarRef.current = beatsPerBar;
  }, [beatsPerMinute, beatsPerBar]);

  const stopAudio = useCallback(() => {
    startTokenRef.current += 1;
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

  useStopWhenAppInactive(() => setMetronomeState({ phase: 'idle' }), stopAudio);

  const start = useCallback(async () => {
    stopAudio();
    const startToken = startTokenRef.current;
    let pendingAudioContext: AudioContext | null = null;
    try {
      AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default', iosOptions: [] });
      const audioContext = new AudioContext();
      pendingAudioContext = audioContext;
      await audioContext.resume();
      if (startTokenRef.current !== startToken) {
        void audioContext.close().catch(() => undefined);
        return;
      }
      const accentClick = createClickBuffer(audioContext, true, accentClickAmplitude);
      const regularClick = createClickBuffer(audioContext, false, regularClickAmplitude);
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
          audioContext.currentTime,
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
      if (activeMetronomeRef.current?.audioContext !== pendingAudioContext) {
        void pendingAudioContext?.close().catch(() => undefined);
      }
      if (startTokenRef.current !== startToken) return;
      stopAudio();
      setMetronomeState({ phase: 'error', errorMessage: String(startError) });
    }
  }, [stopAudio]);

  return { metronomeState, start, stop };
}
