/**
 * Trocea el audio continuo del micrófono en ventanas de duración fija (5 s para el modelo),
 * con solape opcional. Guarda solo la última ventana en un búfer circular: si el análisis va
 * más lento que el audio, se salta ventanas y siempre entrega la más reciente.
 */

/** Salto entre ventanas con solape (la mitad de la ventana del modelo). */
export const overlappedHopSeconds = 2.5;
/** Sin solape: una ventana detrás de otra. */
export const contiguousHopSeconds = 5;
/**
 * Con solape, cada ventana hay que analizarla en 2,5 s. Si remuestrear y pasar el modelo tarda
 * más de esta fracción del salto, se quita el solape para no saturar el móvil (ni calentarlo).
 */
const maximumBusyFractionForOverlap = 0.6;

/** Elige el salto entre ventanas según lo que tardó el último análisis (null si aún no hay). */
export function chooseHopSeconds(lastAnalysisMilliseconds: number | null): number {
  if (lastAnalysisMilliseconds === null) return overlappedHopSeconds;
  return lastAnalysisMilliseconds <= maximumBusyFractionForOverlap * overlappedHopSeconds * 1000
    ? overlappedHopSeconds
    : contiguousHopSeconds;
}

export interface AudioWindowCollector {
  readonly windowSampleCount: number;
  /** Añade un bloque de muestras (se copian). */
  pushSamples(incomingSamples: ArrayLike<number>): void;
  /**
   * Devuelve una copia de la última ventana completa si desde la anterior han llegado al menos
   * `hopSampleCount` muestras nuevas; si no, `null`.
   */
  takeWindowIfReady(hopSampleCount: number): Float32Array | null;
  reset(): void;
}

export function createAudioWindowCollector(windowSampleCount: number): AudioWindowCollector {
  if (!Number.isInteger(windowSampleCount) || windowSampleCount <= 0) {
    throw new RangeError('La ventana debe tener un número positivo de muestras');
  }
  const ringBuffer = new Float32Array(windowSampleCount);
  let writeIndex = 0;
  let storedSampleCount = 0;
  let samplesSinceLastWindow = 0;

  return {
    windowSampleCount,
    pushSamples(incomingSamples) {
      const incomingLength = incomingSamples.length;
      // Si el bloque es más largo que la ventana, solo cuentan sus últimas muestras.
      const skippedCount = Math.max(0, incomingLength - windowSampleCount);
      for (let sampleIndex = skippedCount; sampleIndex < incomingLength; sampleIndex++) {
        ringBuffer[writeIndex] = incomingSamples[sampleIndex]!;
        writeIndex = (writeIndex + 1) % windowSampleCount;
      }
      storedSampleCount = Math.min(windowSampleCount, storedSampleCount + incomingLength);
      samplesSinceLastWindow += incomingLength;
    },
    takeWindowIfReady(hopSampleCount) {
      if (storedSampleCount < windowSampleCount || samplesSinceLastWindow < hopSampleCount) return null;
      samplesSinceLastWindow = 0;
      // El búfer está lleno: la muestra más antigua es la que toca sobrescribir.
      const windowSamples = new Float32Array(windowSampleCount);
      windowSamples.set(ringBuffer.subarray(writeIndex), 0);
      windowSamples.set(ringBuffer.subarray(0, writeIndex), windowSampleCount - writeIndex);
      return windowSamples;
    },
    reset() {
      ringBuffer.fill(0);
      writeIndex = 0;
      storedSampleCount = 0;
      samplesSinceLastWindow = 0;
    },
  };
}

/** Nivel RMS en dBFS de un trozo (para avisar si el micrófono no capta nada). */
export function rootMeanSquareDecibels(samples: ArrayLike<number>): number {
  let squaredSum = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) squaredSum += samples[sampleIndex]! ** 2;
  return 10 * Math.log10(Math.max(1e-20, squaredSum / Math.max(1, samples.length)));
}
