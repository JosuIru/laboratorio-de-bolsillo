import { useCallback, useEffect, useRef } from 'react';
import { Vibration } from 'react-native';
import { AudioContext, AudioManager } from 'react-native-audio-api';

import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';

import { alarmVibrationPattern, generateAlarmPattern } from './alarmPattern';

/**
 * Alarma de fin de ciclo: pitidos en bucle y vibración repetida mientras `isRinging` sea
 * verdadero. Sin notificaciones del sistema, solo suena con la app en primer plano (la pantalla
 * se mantiene encendida mientras se vigila).
 */
export function useCycleAlarm(isRinging: boolean) {
  const audioContextRef = useRef<AudioContext | null>(null);

  const stopAlarm = useCallback(() => {
    Vibration.cancel();
    const audioContext = audioContextRef.current;
    if (!audioContext) return;
    audioContextRef.current = null;
    void audioContext.close().catch(() => undefined);
  }, []);

  useStopWhenAppInactive(() => undefined, stopAlarm);

  useEffect(() => {
    if (!isRinging) {
      stopAlarm();
      return;
    }
    let isCancelled = false;
    // La vibración va aparte del audio: si el audio falla (o está en silencio), al menos vibra.
    Vibration.vibrate(alarmVibrationPattern, true);
    const startSound = async () => {
      try {
        AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default', iosOptions: [] });
        const audioContext = new AudioContext();
        await audioContext.resume();
        if (isCancelled) {
          void audioContext.close().catch(() => undefined);
          return;
        }
        audioContextRef.current = audioContext;
        const patternSamples = generateAlarmPattern(audioContext.sampleRate);
        const patternBuffer = audioContext.createBuffer(1, patternSamples.length, audioContext.sampleRate);
        patternBuffer.copyToChannel(patternSamples, 0);
        const patternSource = audioContext.createBufferSource();
        patternSource.buffer = patternBuffer;
        patternSource.loop = true;
        patternSource.connect(audioContext.destination);
        patternSource.start();
      } catch {
        // Sin audio queda la vibración.
      }
    };
    void startSound();
    return () => {
      isCancelled = true;
      stopAlarm();
    };
  }, [isRinging, stopAlarm]);
}
