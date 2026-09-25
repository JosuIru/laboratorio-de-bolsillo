/**
 * Buffer circular de tamaño fijo sobre Float64Array: guarda las últimas `capacity` muestras
 * sin reservar memoria nueva. Base para ventanas deslizantes (FFT del sismógrafo, gráficas).
 */
export interface RingBuffer {
  readonly capacity: number;
  readonly values: Float64Array;
  writeIndex: number;
  storedCount: number;
}

export function createRingBuffer(capacity: number): RingBuffer {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`Capacidad no válida: ${capacity}`);
  return { capacity, values: new Float64Array(capacity), writeIndex: 0, storedCount: 0 };
}

export function pushToRingBuffer(ringBuffer: RingBuffer, sampleValue: number): void {
  'worklet';
  ringBuffer.values[ringBuffer.writeIndex] = sampleValue;
  ringBuffer.writeIndex = (ringBuffer.writeIndex + 1) % ringBuffer.capacity;
  if (ringBuffer.storedCount < ringBuffer.capacity) ringBuffer.storedCount++;
}

/**
 * Copia las últimas `sampleCount` muestras, de la más antigua a la más reciente, en `output`.
 * Devuelve cuántas ha copiado (menos si todavía no hay suficientes).
 */
export function copyLatestFromRingBuffer(
  ringBuffer: RingBuffer,
  output: Float32Array | Float64Array,
  sampleCount = output.length,
): number {
  'worklet';
  const copiedCount = Math.min(sampleCount, ringBuffer.storedCount, output.length);
  const firstIndex = (ringBuffer.writeIndex - copiedCount + ringBuffer.capacity) % ringBuffer.capacity;
  for (let outputIndex = 0; outputIndex < copiedCount; outputIndex++) {
    output[outputIndex] = ringBuffer.values[(firstIndex + outputIndex) % ringBuffer.capacity]!;
  }
  return copiedCount;
}

export function clearRingBuffer(ringBuffer: RingBuffer): void {
  'worklet';
  ringBuffer.writeIndex = 0;
  ringBuffer.storedCount = 0;
}
