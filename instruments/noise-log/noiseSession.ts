import { decibelsToEnergy, energyToDecibels, equivalentContinuousLevel, percentileExceededLevel } from './soundLevels';

/**
 * Registro de una sesión de ruido. Recibe niveles de ventanas cortas (≈0,15 s) y los agrupa en
 * segundos (Leq de 1 s y máximo) y en minutos de reloj (Leq por minuto y máximo). No guarda
 * audio: solo estos niveles.
 */

const millisecondsPerSecond = 1000;
const millisecondsPerMinute = 60_000;

export interface MinuteLevelRow {
  /** Inicio del minuto de reloj (epoch en ms, múltiplo de 60 000). */
  minuteStartTimestamp: number;
  equivalentLevelDecibels: number;
  maximumLevelDecibels: number;
  /** Ventanas cortas medidas en ese minuto (el primero y el último suelen estar incompletos). */
  shortWindowCount: number;
}

export interface SecondLevelSeries {
  /** Inicio de cada segundo registrado (epoch en ms). Puede haber huecos si se perdieron tramas. */
  startTimestamps: number[];
  /** Leq de cada segundo. */
  equivalentLevels: number[];
  /** Máximo de las ventanas cortas de cada segundo. */
  maximumLevels: number[];
}

interface LevelAccumulator {
  bucketStartTimestamp: number;
  energySum: number;
  shortWindowCount: number;
  maximumLevelDecibels: number;
}

function createAccumulator(bucketStartTimestamp: number): LevelAccumulator {
  return { bucketStartTimestamp, energySum: 0, shortWindowCount: 0, maximumLevelDecibels: -Infinity };
}

function addToAccumulator(accumulator: LevelAccumulator, levelDecibels: number) {
  accumulator.energySum += decibelsToEnergy(levelDecibels);
  accumulator.shortWindowCount++;
  if (levelDecibels > accumulator.maximumLevelDecibels) accumulator.maximumLevelDecibels = levelDecibels;
}

function accumulatorLevel(accumulator: LevelAccumulator): number {
  return energyToDecibels(accumulator.energySum / accumulator.shortWindowCount);
}

export function createNoiseSessionLog(sessionStartTimestamp: number) {
  const secondSeries: SecondLevelSeries = { startTimestamps: [], equivalentLevels: [], maximumLevels: [] };
  const completedMinuteRows: MinuteLevelRow[] = [];
  let currentSecond: LevelAccumulator | null = null;
  let currentMinute: LevelAccumulator | null = null;
  let lastTimestamp = sessionStartTimestamp;

  function closeCurrentSecond() {
    if (!currentSecond || currentSecond.shortWindowCount === 0) return;
    secondSeries.startTimestamps.push(currentSecond.bucketStartTimestamp);
    secondSeries.equivalentLevels.push(accumulatorLevel(currentSecond));
    secondSeries.maximumLevels.push(currentSecond.maximumLevelDecibels);
    currentSecond = null;
  }

  function minuteRowFrom(accumulator: LevelAccumulator): MinuteLevelRow {
    return {
      minuteStartTimestamp: accumulator.bucketStartTimestamp,
      equivalentLevelDecibels: accumulatorLevel(accumulator),
      maximumLevelDecibels: accumulator.maximumLevelDecibels,
      shortWindowCount: accumulator.shortWindowCount,
    };
  }

  return {
    sessionStartTimestamp,

    /** Añade el nivel de una ventana corta. Las marcas de tiempo deben ir en orden. */
    pushShortWindowLevel(timestamp: number, levelDecibels: number) {
      if (!Number.isFinite(levelDecibels) || timestamp < sessionStartTimestamp) return;
      lastTimestamp = Math.max(lastTimestamp, timestamp);
      const secondStartTimestamp =
        sessionStartTimestamp +
        Math.floor((timestamp - sessionStartTimestamp) / millisecondsPerSecond) * millisecondsPerSecond;
      if (currentSecond && currentSecond.bucketStartTimestamp !== secondStartTimestamp) closeCurrentSecond();
      currentSecond ??= createAccumulator(secondStartTimestamp);
      addToAccumulator(currentSecond, levelDecibels);

      const minuteStartTimestamp = Math.floor(timestamp / millisecondsPerMinute) * millisecondsPerMinute;
      if (currentMinute && currentMinute.bucketStartTimestamp !== minuteStartTimestamp) {
        completedMinuteRows.push(minuteRowFrom(currentMinute));
        currentMinute = null;
      }
      currentMinute ??= createAccumulator(minuteStartTimestamp);
      addToAccumulator(currentMinute, levelDecibels);
    },

    /** Cierra el segundo en curso (llámalo al parar). */
    finish() {
      closeCurrentSecond();
    },

    /** Segundos completos registrados hasta ahora (el array se reutiliza: no lo modifiques). */
    readSecondSeries(): SecondLevelSeries {
      return secondSeries;
    },

    /** Filas por minuto, incluido el minuto en curso. */
    readMinuteRows(): MinuteLevelRow[] {
      return currentMinute && currentMinute.shortWindowCount > 0
        ? [...completedMinuteRows, minuteRowFrom(currentMinute)]
        : [...completedMinuteRows];
    },

    readElapsedSeconds(): number {
      return (lastTimestamp - sessionStartTimestamp) / millisecondsPerSecond;
    },
  };
}

export type NoiseSessionLog = ReturnType<typeof createNoiseSessionLog>;

export interface NoiseSessionSummary {
  equivalentLevelDecibels: number;
  maximumLevelDecibels: number;
  /** Nivel superado el 10 % del tiempo (ruidos que destacan), sobre Leq de 1 s. */
  level10Decibels: number;
  /** Nivel superado el 90 % del tiempo (ruido de fondo), sobre Leq de 1 s. */
  level90Decibels: number;
  measuredSeconds: number;
}

/** Resumen del periodo: Leq, máximo y percentiles L10/L90 a partir de los segundos registrados. */
export function summarizeSecondSeries(secondSeries: SecondLevelSeries): NoiseSessionSummary | null {
  const equivalentLevelDecibels = equivalentContinuousLevel(secondSeries.equivalentLevels);
  const level10Decibels = percentileExceededLevel(secondSeries.equivalentLevels, 10);
  const level90Decibels = percentileExceededLevel(secondSeries.equivalentLevels, 90);
  if (equivalentLevelDecibels === null || level10Decibels === null || level90Decibels === null) return null;
  let maximumLevelDecibels = -Infinity;
  for (const secondMaximum of secondSeries.maximumLevels) {
    if (secondMaximum > maximumLevelDecibels) maximumLevelDecibels = secondMaximum;
  }
  return {
    equivalentLevelDecibels,
    maximumLevelDecibels,
    level10Decibels,
    level90Decibels,
    measuredSeconds: secondSeries.equivalentLevels.length,
  };
}

export interface NoiseEpisode {
  startTimestamp: number;
  durationSeconds: number;
  maximumLevelDecibels: number;
  equivalentLevelDecibels: number;
}

export interface EpisodeDetectionOptions {
  /** Un segundo cuenta como ruidoso si su Leq de 1 s supera este nivel. */
  thresholdDecibels: number;
  /** Solo se anotan los episodios que duran al menos esto. */
  minimumDurationSeconds: number;
  /** Silencios más cortos que esto no cortan el episodio (p. ej. entre golpes o ladridos). */
  toleratedGapSeconds: number;
}

/**
 * Episodios: tramos en que el nivel supera el umbral durante al menos `minimumDurationSeconds`.
 * Se recalculan desde los segundos, así que el umbral se puede cambiar después de medir.
 */
export function detectNoiseEpisodes(secondSeries: SecondLevelSeries, options: EpisodeDetectionOptions): NoiseEpisode[] {
  const { startTimestamps, equivalentLevels, maximumLevels } = secondSeries;
  const detectedEpisodes: NoiseEpisode[] = [];
  const toleratedGapMilliseconds = options.toleratedGapSeconds * millisecondsPerSecond;
  let episodeFirstIndex = -1;
  let episodeLastLoudIndex = -1;

  function closeEpisode() {
    if (episodeFirstIndex < 0) return;
    const startTimestamp = startTimestamps[episodeFirstIndex]!;
    const endTimestamp = startTimestamps[episodeLastLoudIndex]! + millisecondsPerSecond;
    const durationSeconds = (endTimestamp - startTimestamp) / millisecondsPerSecond;
    if (durationSeconds >= options.minimumDurationSeconds) {
      let maximumLevelDecibels = -Infinity;
      let energySum = 0;
      for (let secondIndex = episodeFirstIndex; secondIndex <= episodeLastLoudIndex; secondIndex++) {
        maximumLevelDecibels = Math.max(maximumLevelDecibels, maximumLevels[secondIndex]!);
        energySum += decibelsToEnergy(equivalentLevels[secondIndex]!);
      }
      detectedEpisodes.push({
        startTimestamp,
        durationSeconds,
        maximumLevelDecibels,
        equivalentLevelDecibels: energyToDecibels(energySum / (episodeLastLoudIndex - episodeFirstIndex + 1)),
      });
    }
    episodeFirstIndex = -1;
    episodeLastLoudIndex = -1;
  }

  for (let secondIndex = 0; secondIndex < startTimestamps.length; secondIndex++) {
    const isLoudSecond = equivalentLevels[secondIndex]! > options.thresholdDecibels;
    if (episodeFirstIndex >= 0) {
      // Silencio o hueco en los datos desde el último segundo ruidoso: ¿corta el episodio?
      const quietMilliseconds =
        startTimestamps[secondIndex]! - (startTimestamps[episodeLastLoudIndex]! + millisecondsPerSecond);
      const quietLimitMilliseconds = isLoudSecond ? toleratedGapMilliseconds : toleratedGapMilliseconds - millisecondsPerSecond;
      if (quietMilliseconds > quietLimitMilliseconds) closeEpisode();
    }
    if (!isLoudSecond) continue;
    if (episodeFirstIndex < 0) episodeFirstIndex = secondIndex;
    episodeLastLoudIndex = secondIndex;
  }
  closeEpisode();
  return detectedEpisodes;
}
