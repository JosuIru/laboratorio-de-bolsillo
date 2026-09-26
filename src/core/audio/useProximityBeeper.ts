import { useCallback, useEffect, useRef } from 'react';
import { AudioContext, AudioManager } from 'react-native-audio-api';

import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import { beepFrequencyHz, beepIntervalSeconds } from '@/processing/bluetooth/proximity';
import { applyFadesInPlace, generateTone } from '@/processing/dsp/signalGenerator';

const beepDurationSeconds = 0.05;
const beepFadeSeconds = 0.004;
const beepAmplitude = 0.6;

interface ActiveBeeper {
  audioContext: AudioContext;
  nextBeepTimeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Pitidos tipo contador Geiger para el modo buscar: más rápidos y agudos cuanto más «caliente».
 * `heat` es `null` cuando se ha perdido la señal: entonces calla.
 */
export function useProximityBeeper(isEnabled: boolean, heat: number | null) {
  const heatRef = useRef(heat);
  const activeBeeperRef = useRef<ActiveBeeper | null>(null);

  useEffect(() => {
    heatRef.current = heat;
  }, [heat]);

  const stopBeeper = useCallback(() => {
    const activeBeeper = activeBeeperRef.current;
    if (!activeBeeper) return;
    activeBeeperRef.current = null;
    if (activeBeeper.nextBeepTimeout) clearTimeout(activeBeeper.nextBeepTimeout);
    void activeBeeper.audioContext.close().catch(() => undefined);
  }, []);

  useStopWhenAppInactive(() => undefined, stopBeeper);

  useEffect(() => {
    if (!isEnabled) {
      stopBeeper();
      return;
    }
    let isCancelled = false;
    const startBeeper = async () => {
      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default', iosOptions: [] });
        const audioContext = new AudioContext();
        await audioContext.resume();
        if (isCancelled) {
          void audioContext.close().catch(() => undefined);
          return;
        }
        const activeBeeper: ActiveBeeper = { audioContext, nextBeepTimeout: null };
        activeBeeperRef.current = activeBeeper;

        const playBeepAndScheduleNext = () => {
          if (activeBeeperRef.current !== activeBeeper) return;
          const currentHeat = heatRef.current;
          if (currentHeat !== null) {
            const sampleRateHz = audioContext.sampleRate;
            const beepSamples = generateTone({
              frequencyHz: beepFrequencyHz(currentHeat),
              sampleRateHz,
              durationSeconds: beepDurationSeconds,
              amplitude: beepAmplitude,
            });
            applyFadesInPlace(beepSamples, Math.round(beepFadeSeconds * sampleRateHz));
            const beepBuffer = audioContext.createBuffer(1, beepSamples.length, sampleRateHz);
            beepBuffer.copyToChannel(new Float32Array(beepSamples), 0);
            const beepSource = audioContext.createBufferSource();
            beepSource.buffer = beepBuffer;
            beepSource.connect(audioContext.destination);
            beepSource.start();
          }
          // Sin señal, vuelve a mirar dentro de un rato sin pitar.
          const waitSeconds = currentHeat === null ? 0.5 : beepIntervalSeconds(currentHeat);
          activeBeeper.nextBeepTimeout = setTimeout(playBeepAndScheduleNext, waitSeconds * 1000);
        };
        playBeepAndScheduleNext();
      } catch {
        stopBeeper();
      }
    };
    void startBeeper();
    return () => {
      isCancelled = true;
      stopBeeper();
    };
  }, [isEnabled, stopBeeper]);
}
