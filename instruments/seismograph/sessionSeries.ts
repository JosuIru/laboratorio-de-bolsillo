/**
 * Serie cruda de toda la sesión (desde el último «Reiniciar»), para el CSV que se guarda: así
 * cubre el mismo tiempo que la duración, el pico y los eventos. Crece por duplicación hasta
 * `maximumSampleCount`; a partir de ahí deja de guardar y marca la serie como recortada.
 */
export interface SessionSeriesLog {
  push(timestampSeconds: number, x: number, y: number, z: number): void;
  readonly sampleCount: number;
  readonly isTruncated: boolean;
  /** Copias ordenadas de lo guardado. */
  read(): { timestampsSeconds: Float64Array; x: Float32Array; y: Float32Array; z: Float32Array };
  reset(): void;
}

const initialCapacity = 4096;

export function createSessionSeriesLog(maximumSampleCount: number): SessionSeriesLog {
  let timestampsSeconds = new Float64Array(initialCapacity);
  let xValues = new Float32Array(initialCapacity);
  let yValues = new Float32Array(initialCapacity);
  let zValues = new Float32Array(initialCapacity);
  let storedCount = 0;
  let isTruncated = false;

  function grow() {
    const newCapacity = Math.min(maximumSampleCount, timestampsSeconds.length * 2);
    const copyInto = <TArray extends Float64Array | Float32Array>(grown: TArray, stored: TArray) => {
      grown.set(stored.subarray(0, storedCount));
      return grown;
    };
    timestampsSeconds = copyInto(new Float64Array(newCapacity), timestampsSeconds);
    xValues = copyInto(new Float32Array(newCapacity), xValues);
    yValues = copyInto(new Float32Array(newCapacity), yValues);
    zValues = copyInto(new Float32Array(newCapacity), zValues);
  }

  return {
    push(timestampSeconds, x, y, z) {
      if (storedCount >= maximumSampleCount) {
        isTruncated = true;
        return;
      }
      if (storedCount >= timestampsSeconds.length) grow();
      timestampsSeconds[storedCount] = timestampSeconds;
      xValues[storedCount] = x;
      yValues[storedCount] = y;
      zValues[storedCount] = z;
      storedCount++;
    },
    get sampleCount() {
      return storedCount;
    },
    get isTruncated() {
      return isTruncated;
    },
    read() {
      return {
        timestampsSeconds: timestampsSeconds.slice(0, storedCount),
        x: xValues.slice(0, storedCount),
        y: yValues.slice(0, storedCount),
        z: zValues.slice(0, storedCount),
      };
    },
    reset() {
      timestampsSeconds = new Float64Array(initialCapacity);
      xValues = new Float32Array(initialCapacity);
      yValues = new Float32Array(initialCapacity);
      zValues = new Float32Array(initialCapacity);
      storedCount = 0;
      isTruncated = false;
    },
  };
}
