import type { AudioRecorder } from 'react-native-audio-api';

/**
 * react-native-audio-api solo admite un grabador activo a la vez, y `start()`/`stop()` se
 * reparten en un pool de hilos nativos sin orden garantizado: una parada puede ejecutarse antes
 * que un arranque pendiente y dejar el grabador encendido sin dueño. Aquí todas las llamadas
 * pasan por una única cola global: un arranque espera a las paradas anteriores y una parada
 * espera al arranque pendiente.
 */
let recorderOperationChain: Promise<unknown> = Promise.resolve();

/** Reintentos si otro instrumento aún no ha soltado el grabador (su parada llega tras un render). */
const startRetryCount = 5;
const startRetryDelayMilliseconds = 100;

export type RecorderStartResult = Awaited<ReturnType<AudioRecorder['start']>>;
type QueueableRecorder = Pick<AudioRecorder, 'start' | 'stop'>;

function enqueueRecorderOperation<OperationResult>(
  recorderOperation: () => Promise<OperationResult>,
): Promise<OperationResult> {
  const operationPromise = recorderOperationChain.then(recorderOperation);
  recorderOperationChain = operationPromise.catch(() => undefined);
  return operationPromise;
}

/** Para el grabador cuando terminen las operaciones anteriores. Nunca rechaza. */
export function stopRecorderInOrder(audioRecorder: QueueableRecorder): Promise<void> {
  return enqueueRecorderOperation(async () => {
    await audioRecorder.stop().catch(() => undefined);
  });
}

/**
 * Arranca el grabador en su turno. Devuelve `null` si se canceló: en ese caso el grabador queda
 * parado aunque la cancelación llegase con el arranque ya en marcha. Si el arranque falla
 * (p. ej. «Another recording is already in progress») reintenta unas cuantas veces.
 */
export async function startRecorderInOrder(
  audioRecorder: QueueableRecorder,
  isCancelled: () => boolean,
): Promise<RecorderStartResult | null> {
  for (let attemptIndex = 0; ; attemptIndex++) {
    const startResult = await enqueueRecorderOperation(async () => {
      if (isCancelled()) return null;
      const attemptResult = await audioRecorder.start();
      if (isCancelled()) {
        // Dentro del mismo turno, para que el siguiente arranque encuentre el grabador libre.
        if (attemptResult.status !== 'error') await audioRecorder.stop().catch(() => undefined);
        return null;
      }
      return attemptResult;
    });
    if (!startResult || startResult.status !== 'error' || attemptIndex >= startRetryCount) return startResult;
    await new Promise((resolve) => setTimeout(resolve, startRetryDelayMilliseconds));
    if (isCancelled()) return null;
  }
}
