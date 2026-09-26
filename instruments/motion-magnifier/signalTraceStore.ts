/**
 * Traza en vivo de la señal filtrada de la zona de medida: un búfer circular que la pantalla
 * llena a ritmo de cámara. Avisa a los suscriptores uno de cada `notifyEveryPushes` valores, así
 * el monitor se redibuja a ~15 Hz y no vuelve a pintar la pantalla entera.
 */
export function createSignalTraceStore(capacity: number, notifyEveryPushes = 2) {
  const traceValues = new Float32Array(capacity);
  let nextWriteIndex = 0;
  let storedCount = 0;
  let pushesSinceNotify = 0;
  let revision = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    revision++;
    listeners.forEach((listener) => listener());
  };
  return {
    push(traceValue: number) {
      traceValues[nextWriteIndex] = traceValue;
      nextWriteIndex = (nextWriteIndex + 1) % capacity;
      storedCount = Math.min(capacity, storedCount + 1);
      pushesSinceNotify++;
      if (pushesSinceNotify >= notifyEveryPushes) {
        pushesSinceNotify = 0;
        notify();
      }
    },
    clear() {
      nextWriteIndex = 0;
      storedCount = 0;
      notify();
    },
    /** Copia ordenada (del más antiguo al más reciente) de los valores guardados. */
    readInOrder(): Float32Array {
      const orderedValues = new Float32Array(storedCount);
      for (let orderIndex = 0; orderIndex < storedCount; orderIndex++) {
        orderedValues[orderIndex] = traceValues[(nextWriteIndex - storedCount + orderIndex + capacity) % capacity]!;
      }
      return orderedValues;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getRevision: () => revision,
    capacity,
  };
}

export type SignalTraceStore = ReturnType<typeof createSignalTraceStore>;
