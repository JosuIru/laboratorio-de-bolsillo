/**
 * Tiempos de los fotogramas. La marca de tiempo de la cámara llega en nanosegundos en Android y
 * en segundos en iOS; aquí se deduce la unidad por el tamaño del intervalo entre fotogramas
 * (a 1-240 fotogramas/s, el intervalo mide 4 ms-1 s) y se estima la frecuencia real de muestreo.
 */

/** Factor para pasar un intervalo entre fotogramas a segundos, según su magnitud. */
export function detectTimestampSecondsPerUnit(frameIntervalInUnknownUnits: number): number {
  const intervalMagnitude = Math.abs(frameIntervalInUnknownUnits);
  if (intervalMagnitude >= 1e6) return 1e-9; // nanosegundos
  if (intervalMagnitude >= 1e3) return 1e-6; // microsegundos
  if (intervalMagnitude >= 1) return 1e-3; // milisegundos
  return 1; // segundos
}

export interface FrameClock {
  /**
   * Convierte la marca de tiempo del fotograma a segundos desde el primero. Devuelve null
   * mientras no se conoce la unidad (el primer fotograma) o si el tiempo no avanza.
   */
  toSeconds(rawTimestamp: number): number | null;
  /** Fotogramas por segundo estimados (mediana de los últimos intervalos) o null si aún no hay. */
  estimatedFramesPerSecond(): number | null;
  reset(): void;
}

/** Intervalos que se guardan para la mediana (~2 s a 30 fotogramas/s). */
const storedIntervalCount = 60;
/** Intervalos mínimos antes de dar una estimación. */
const minimumIntervalCountForEstimate = 15;

export function createFrameClock(): FrameClock {
  let firstRawTimestamp: number | null = null;
  let previousRawTimestamp: number | null = null;
  let secondsPerUnit: number | null = null;
  let recentIntervalsSeconds: number[] = [];

  return {
    toSeconds(rawTimestamp) {
      if (!Number.isFinite(rawTimestamp)) return null;
      if (firstRawTimestamp === null || previousRawTimestamp === null) {
        firstRawTimestamp = rawTimestamp;
        previousRawTimestamp = rawTimestamp;
        return null;
      }
      const rawInterval = rawTimestamp - previousRawTimestamp;
      if (!(rawInterval > 0)) return null;
      if (secondsPerUnit === null) {
        secondsPerUnit = detectTimestampSecondsPerUnit(rawInterval);
      }
      previousRawTimestamp = rawTimestamp;
      recentIntervalsSeconds.push(rawInterval * secondsPerUnit);
      if (recentIntervalsSeconds.length > storedIntervalCount) recentIntervalsSeconds.shift();
      return (rawTimestamp - firstRawTimestamp) * secondsPerUnit;
    },
    estimatedFramesPerSecond() {
      if (recentIntervalsSeconds.length < minimumIntervalCountForEstimate) return null;
      const sortedIntervals = [...recentIntervalsSeconds].sort((left, right) => left - right);
      const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)]!;
      return medianInterval > 0 ? 1 / medianInterval : null;
    },
    reset() {
      firstRawTimestamp = null;
      previousRawTimestamp = null;
      secondsPerUnit = null;
      recentIntervalsSeconds = [];
    },
  };
}
