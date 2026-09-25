import type { AudioRecorder } from 'react-native-audio-api';

/**
 * react-native-audio-api solo admite una grabadora activa a la vez, y `start()`/`stop()` corren en
 * hilos nativos sin orden garantizado. El receptor y la autoprueba se turnan el micrófono: cada
 * arranque espera a que terminen las paradas pendientes y reintenta un poco si la otra grabadora
 * todavía no ha soltado el micrófono (su parada llega tras el siguiente render).
 */
let pendingMicrophoneRelease: Promise<unknown> = Promise.resolve();

const startRetryCount = 5;
const startRetryDelayMilliseconds = 100;

type RecorderStartResult = Awaited<ReturnType<AudioRecorder['start']>>;

export function stopRecorderExclusively(audioRecorder: AudioRecorder): Promise<unknown> {
  const stopPromise = audioRecorder.stop().catch(() => undefined);
  pendingMicrophoneRelease = Promise.all([pendingMicrophoneRelease, stopPromise]);
  return stopPromise;
}

export async function startRecorderExclusively(
  audioRecorder: AudioRecorder,
  isCancelled: () => boolean,
): Promise<RecorderStartResult | null> {
  for (let attemptIndex = 0; ; attemptIndex++) {
    await pendingMicrophoneRelease;
    if (isCancelled()) return null;
    const startResult = await audioRecorder.start();
    if (isCancelled()) {
      // Si la parada de la limpieza se ejecutó antes que este arranque, la grabadora seguiría viva.
      if (startResult.status !== 'error') void stopRecorderExclusively(audioRecorder);
      return null;
    }
    if (startResult.status !== 'error' || attemptIndex >= startRetryCount) return startResult;
    await new Promise((resolve) => setTimeout(resolve, startRetryDelayMilliseconds));
  }
}
