/** Forma de onda cruda alrededor de una llegada, copiada del historial en el momento del golpe. */
export interface ArrivalWaveform {
  timestamps: Float64Array;
  accelerationX: Float64Array;
  accelerationY: Float64Array;
  accelerationZ: Float64Array;
  /** Golpe de sincronización vigente cuando llegó la onda (para contar el tiempo desde él). */
  syncTimestampSeconds: number;
}

/**
 * Recorta las muestras con marca de tiempo entre `startSeconds` y `endSeconds` (ambos
 * incluidos). Las series van ordenadas en el tiempo, de la más antigua a la más reciente.
 */
export function extractArrivalWaveform(
  series: { timestamps: Float64Array; accelerationX: Float64Array; accelerationY: Float64Array; accelerationZ: Float64Array },
  startSeconds: number,
  endSeconds: number,
  syncTimestampSeconds: number,
): ArrivalWaveform {
  let firstIndex = 0;
  while (firstIndex < series.timestamps.length && series.timestamps[firstIndex]! < startSeconds) firstIndex++;
  let endIndex = firstIndex;
  while (endIndex < series.timestamps.length && series.timestamps[endIndex]! <= endSeconds) endIndex++;
  return {
    timestamps: series.timestamps.slice(firstIndex, endIndex),
    accelerationX: series.accelerationX.slice(firstIndex, endIndex),
    accelerationY: series.accelerationY.slice(firstIndex, endIndex),
    accelerationZ: series.accelerationZ.slice(firstIndex, endIndex),
    syncTimestampSeconds,
  };
}
