/**
 * Nivel de vibración por ventanas: valor eficaz de la aceleración dinámica (sin la gravedad).
 *
 * En cada ventana se quita la media de cada eje (la gravedad y la inclinación del móvil, que no
 * cambian en un segundo) y se suma la varianza de los tres ejes: es el valor eficaz del módulo
 * de la aceleración dinámica. Equivale a un paso alto de ~1 Hz, no depende de la frecuencia de
 * muestreo real y solo guarda unas sumas: nada de buffers ni filtros por muestra.
 */

/** Ventana de nivel ya cerrada. Los tiempos van en segundos del reloj de pared. */
export interface LevelWindow {
  startSeconds: number;
  endSeconds: number;
  /** Valor eficaz de la aceleración dinámica en la ventana, en m/s². */
  level: number;
  sampleCount: number;
}

/** Ventana cerrada, con tiempos del sensor (el hook los pasa a reloj de pared). */
export interface SensorLevelWindow {
  startTimestampSeconds: number;
  endTimestampSeconds: number;
  level: number;
  sampleCount: number;
}

export interface WindowLevelOptions {
  windowSeconds: number;
  /** Hueco entre muestras a partir del cual se tira la ventana a medias y se empieza otra. */
  maximumGapSeconds: number;
  /** Menos muestras que esto en una ventana (sensor atascado) y no se da nivel. */
  minimumSampleCount: number;
}

export const defaultWindowLevelOptions: WindowLevelOptions = {
  windowSeconds: 1,
  maximumGapSeconds: 1,
  minimumSampleCount: 5,
};

interface AxisSums {
  /** Primera muestra del eje en la ventana: se resta para no perder precisión con la gravedad. */
  offset: number;
  sum: number;
  sumOfSquares: number;
}

function createAxisSums(): AxisSums {
  return { offset: 0, sum: 0, sumOfSquares: 0 };
}

function addToAxis(axisSums: AxisSums, axisValue: number, isFirstSample: boolean) {
  if (isFirstSample) axisSums.offset = axisValue;
  const centeredValue = axisValue - axisSums.offset;
  axisSums.sum += centeredValue;
  axisSums.sumOfSquares += centeredValue * centeredValue;
}

function axisVariance(axisSums: AxisSums, sampleCount: number): number {
  const mean = axisSums.sum / sampleCount;
  return Math.max(0, axisSums.sumOfSquares / sampleCount - mean * mean);
}

/**
 * Acumula muestras del acelerómetro (m/s², gravedad incluida) y devuelve una ventana cada
 * `windowSeconds`. `push` devuelve `null` mientras la ventana no se ha cerrado.
 */
export function createWindowLevelMeter(options: WindowLevelOptions = defaultWindowLevelOptions) {
  const axes = [createAxisSums(), createAxisSums(), createAxisSums()] as const;
  let windowStartTimestamp: number | null = null;
  let previousTimestamp: number | null = null;
  let sampleCount = 0;

  function startWindow(timestampSeconds: number) {
    windowStartTimestamp = timestampSeconds;
    sampleCount = 0;
    for (const axisSums of axes) Object.assign(axisSums, createAxisSums());
  }

  function reset() {
    windowStartTimestamp = null;
    previousTimestamp = null;
    sampleCount = 0;
  }

  function push(timestampSeconds: number, x: number, y: number, z: number): SensorLevelWindow | null {
    const hasGap = previousTimestamp !== null && timestampSeconds - previousTimestamp > options.maximumGapSeconds;
    const isOutOfOrder = previousTimestamp !== null && timestampSeconds < previousTimestamp;
    previousTimestamp = timestampSeconds;
    if (windowStartTimestamp === null || hasGap || isOutOfOrder) startWindow(timestampSeconds);

    let closedWindow: SensorLevelWindow | null = null;
    if (timestampSeconds - windowStartTimestamp! >= options.windowSeconds) {
      if (sampleCount >= options.minimumSampleCount) {
        const totalVariance =
          axisVariance(axes[0], sampleCount) + axisVariance(axes[1], sampleCount) + axisVariance(axes[2], sampleCount);
        closedWindow = {
          startTimestampSeconds: windowStartTimestamp!,
          endTimestampSeconds: timestampSeconds,
          level: Math.sqrt(totalVariance),
          sampleCount,
        };
      }
      startWindow(timestampSeconds);
    }
    const isFirstSample = sampleCount === 0;
    addToAxis(axes[0], x, isFirstSample);
    addToAxis(axes[1], y, isFirstSample);
    addToAxis(axes[2], z, isFirstSample);
    sampleCount++;
    return closedWindow;
  }

  return { push, reset };
}

/** Nivel más bajo que se dibuja: por debajo, el ruido del propio sensor. */
const minimumDrawableLevel = 0.001;

/** Nivel en decibelios respecto a 1 m/s², para dibujar pausas y centrifugado en la misma gráfica. */
export function levelToDecibels(level: number): number {
  return 20 * Math.log10(Math.max(level, minimumDrawableLevel));
}

/**
 * Reduce la historia completa a `bucketCount` puntos tomando el máximo de cada tramo, para que
 * un pico corto (el centrifugado) no desaparezca al dibujar horas de ciclo en pocos píxeles.
 */
export function summarizeLevelHistory(levels: readonly number[], bucketCount: number): Float64Array {
  if (levels.length <= bucketCount) return Float64Array.from(levels);
  const summary = new Float64Array(bucketCount);
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
    const firstIndex = Math.floor((bucketIndex * levels.length) / bucketCount);
    const lastIndexExclusive = Math.max(firstIndex + 1, Math.floor(((bucketIndex + 1) * levels.length) / bucketCount));
    let bucketMaximum = -Infinity;
    for (let levelIndex = firstIndex; levelIndex < lastIndexExclusive; levelIndex++) {
      bucketMaximum = Math.max(bucketMaximum, levels[levelIndex]!);
    }
    summary[bucketIndex] = bucketMaximum;
  }
  return summary;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sortedValues = [...values].sort((first, second) => first - second);
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1
    ? sortedValues[middleIndex]!
    : (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
}
