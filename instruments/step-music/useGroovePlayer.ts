import { type RefObject, useEffect } from 'react';
import { type AudioBuffer, AudioContext } from 'react-native-audio-api';

import { useIsScreenActive } from '@/core/useIsScreenActive';

import { synthesizeHat, synthesizeKick, synthesizeNote, synthesizeSnare } from './drumSynth';
import { generateBar, type GrooveEvent, sixteenthSeconds, stepsPerBar } from './grooveGenerator';

/** Cada cuánto se programan golpes y con cuánta antelación (evita tirones del hilo JS). */
const schedulerIntervalMilliseconds = 50;
const scheduleAheadSeconds = 0.25;
const masterVolume = 0.55;
const voiceVolumes: Record<GrooveEvent['voice'], number> = { kick: 1, snare: 0.7, hat: 0.35, bass: 0.6, lead: 0.35 };

export interface GrooveSettings {
  musicBpm: number;
  energy: 0 | 1 | 2 | 3;
}

function toAudioBuffer(audioContext: AudioContext, samples: Float32Array): AudioBuffer {
  const audioBuffer = audioContext.createBuffer(1, samples.length, audioContext.sampleRate);
  // copyToChannel exige un Float32Array respaldado por un ArrayBuffer normal.
  audioBuffer.copyToChannel(new Float32Array(samples), 0);
  return audioBuffer;
}

/**
 * Toca el ritmo mientras `isPlaying`, leyendo tempo y energía de una referencia: los cambios se
 * aplican al empezar cada compás, así el ritmo nunca se descuadra a mitad.
 */
export function useGroovePlayer({
  isPlaying,
  grooveSettingsRef,
  seed,
}: {
  isPlaying: boolean;
  grooveSettingsRef: RefObject<GrooveSettings>;
  seed: number;
}) {
  const isScreenActive = useIsScreenActive();
  const shouldPlay = isPlaying && isScreenActive;

  useEffect(() => {
    if (!shouldPlay) return;
    const audioContext = new AudioContext();
    void audioContext.resume().catch(() => undefined);
    const sampleRateHz = audioContext.sampleRate;
    const masterGain = audioContext.createGain();
    masterGain.gain.value = masterVolume;
    masterGain.connect(audioContext.destination);

    const drumBuffers = {
      kick: toAudioBuffer(audioContext, synthesizeKick(sampleRateHz)),
      snare: toAudioBuffer(audioContext, synthesizeSnare(sampleRateHz)),
      hat: toAudioBuffer(audioContext, synthesizeHat(sampleRateHz)),
    };
    const noteBuffers = new Map<string, AudioBuffer>();
    function noteBuffer(voice: 'bass' | 'lead', midiNote: number): AudioBuffer {
      const noteKey = `${voice}-${midiNote}`;
      let cachedBuffer = noteBuffers.get(noteKey);
      if (!cachedBuffer) {
        cachedBuffer = toAudioBuffer(
          audioContext,
          voice === 'bass'
            ? synthesizeNote(sampleRateHz, midiNote, 0.5, 0.25)
            : synthesizeNote(sampleRateHz, midiNote, 0.35, 0.12),
        );
        noteBuffers.set(noteKey, cachedBuffer);
      }
      return cachedBuffer;
    }

    function scheduleEvent(grooveEvent: GrooveEvent, startSeconds: number) {
      const eventSource = audioContext.createBufferSource();
      eventSource.buffer =
        grooveEvent.voice === 'bass' || grooveEvent.voice === 'lead'
          ? noteBuffer(grooveEvent.voice, grooveEvent.midiNote ?? 60)
          : drumBuffers[grooveEvent.voice];
      const eventGain = audioContext.createGain();
      eventGain.gain.value = voiceVolumes[grooveEvent.voice] * grooveEvent.velocity;
      eventSource.connect(eventGain);
      eventGain.connect(masterGain);
      eventSource.start(startSeconds);
    }

    let barIndex = 0;
    let barEvents: GrooveEvent[] = [];
    let barStepSeconds = sixteenthSeconds(grooveSettingsRef.current.musicBpm);
    let nextStepIndex = 0;
    let nextStepTimeSeconds = audioContext.currentTime + 0.1;

    const schedulerTimer = setInterval(() => {
      while (nextStepTimeSeconds < audioContext.currentTime + scheduleAheadSeconds) {
        if (nextStepIndex === 0) {
          // Compás nuevo: se toman el tempo y la energía de ahora.
          const { musicBpm, energy } = grooveSettingsRef.current;
          barStepSeconds = sixteenthSeconds(musicBpm);
          barEvents = generateBar(barIndex, energy, seed);
        }
        for (const grooveEvent of barEvents) {
          if (grooveEvent.stepIndex === nextStepIndex) scheduleEvent(grooveEvent, nextStepTimeSeconds);
        }
        nextStepTimeSeconds += barStepSeconds;
        nextStepIndex = (nextStepIndex + 1) % stepsPerBar;
        if (nextStepIndex === 0) barIndex++;
      }
    }, schedulerIntervalMilliseconds);

    return () => {
      clearInterval(schedulerTimer);
      void audioContext.close().catch(() => undefined);
    };
  }, [shouldPlay, grooveSettingsRef, seed]);
}
