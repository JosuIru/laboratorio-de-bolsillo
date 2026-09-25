import type { CarrierBandId } from './constellations';
import { isTracked, median } from './skyStatistics';
import { type AutomaticGainControlReading, type SatelliteObservation, signalKey } from './types';

/**
 * Detector de interferencias (jamming) GNSS a partir de lo que da un móvil:
 *
 * 1. **Caída del AGC.** El control automático de ganancia sube cuando la antena recibe poca
 *    potencia y baja cuando entra más ruido en la banda. Una caída brusca del nivel respecto a su
 *    línea base es la señal clásica de un inhibidor (el propio Android lo documenta así).
 * 2. **Caída uniforme del C/N0.** Si el C/N0 de casi todos los satélites baja a la vez varios dB
 *    mientras se siguen recibiendo los mismos satélites (la vista del cielo no ha cambiado), lo más
 *    probable es que haya subido el ruido, no que algo tape la antena: un obstáculo (el cuerpo, un
 *    edificio) afecta a una parte del cielo, no a todo por igual, y hace perder satélites.
 *
 * Aprende una línea base lenta (media exponencial) por señal y por banda, y la compara con una
 * media rápida. Mientras hay alarma congela la línea base, para que una interferencia mantenida
 * no se convierta en «lo normal»; pasado `maximumFrozenBaselineSeconds` vuelve a aprender.
 */

export interface InterferenceDetectorOptions {
  /** Constante de tiempo de la línea base (s). */
  baselineTimeConstantSeconds: number;
  /** Constante de tiempo del valor actual (s): suaviza el ruido de C/N0 y AGC. */
  currentTimeConstantSeconds: number;
  /** Tiempo de aprendizaje antes de empezar a vigilar (s). */
  warmUpSeconds: number;
  /** Una señal o banda solo cuenta si tiene línea base de al menos este tiempo (s). */
  minimumBaselineAgeSeconds: number;
  /** Las señales que no se ven en este tiempo se olvidan (s). */
  forgetAfterSeconds: number;
  /** Caída mediana de C/N0 que se considera anómala (dB). */
  medianCarrierToNoiseDropDb: number;
  /** Caída mínima de una señal para contar como «ha bajado» (dB). */
  perSignalCarrierToNoiseDropDb: number;
  /** Fracción de señales que tienen que haber bajado para hablar de caída uniforme. */
  uniformDropFraction: number;
  /** Señales comunes mínimas para juzgar la uniformidad. */
  minimumCommonSignals: number;
  /** Caída del AGC que se considera anómala (dB). */
  automaticGainControlDropDb: number;
  /** Fracción de señales de la línea base que se siguen recibiendo para decir que el cielo no ha cambiado. */
  stableSkyRetainedFraction: number;
  /** Por debajo de esta fracción se considera pérdida masiva de satélites. */
  massLossRetainedFraction: number;
  /** Tiempo máximo con la línea base congelada por una alarma (s). */
  maximumFrozenBaselineSeconds: number;
}

export const defaultInterferenceDetectorOptions: InterferenceDetectorOptions = {
  baselineTimeConstantSeconds: 20,
  currentTimeConstantSeconds: 2,
  warmUpSeconds: 15,
  minimumBaselineAgeSeconds: 5,
  forgetAfterSeconds: 30,
  medianCarrierToNoiseDropDb: 6,
  perSignalCarrierToNoiseDropDb: 3,
  uniformDropFraction: 0.8,
  minimumCommonSignals: 4,
  automaticGainControlDropDb: 4,
  stableSkyRetainedFraction: 0.7,
  massLossRetainedFraction: 0.5,
  maximumFrozenBaselineSeconds: 90,
};

export type InterferenceLevel = 'none' | 'possible' | 'likely';

export interface AutomaticGainControlDrop {
  bandId: CarrierBandId;
  baselineLevelDb: number;
  currentLevelDb: number;
  dropDb: number;
}

export interface InterferenceAssessment {
  status: 'learning' | 'monitoring';
  /** 0…1 durante el aprendizaje. */
  learningProgress: number;
  level: InterferenceLevel;
  commonSignalCount: number;
  medianCarrierToNoiseDropDb: number | null;
  /** Fracción de señales comunes que han bajado al menos `perSignalCarrierToNoiseDropDb`. */
  droppedSignalFraction: number | null;
  /** Fracción de las señales de la línea base que se siguen recibiendo. */
  retainedSignalFraction: number | null;
  isSkyStable: boolean;
  isCarrierToNoiseDropUniform: boolean;
  isMassSignalLoss: boolean;
  hasAutomaticGainControlData: boolean;
  automaticGainControlDrops: AutomaticGainControlDrop[];
  isAutomaticGainControlDropping: boolean;
  /** La línea base está congelada por una alarma en curso. */
  isBaselineFrozen: boolean;
}

export interface InterferenceEpoch {
  timestampSeconds: number;
  observations: readonly SatelliteObservation[];
  /** Vacío si el chip no da AGC. */
  automaticGainControlReadings: readonly AutomaticGainControlReading[];
}

interface TrackedQuantity {
  baselineValue: number | null;
  baselineAgeSeconds: number;
  currentValue: number;
  lastSeenSeconds: number;
}

/** Peso de una media exponencial para un paso `elapsedSeconds` y constante de tiempo dada. */
export function exponentialSmoothingWeight(elapsedSeconds: number, timeConstantSeconds: number): number {
  if (elapsedSeconds <= 0) return 0;
  return 1 - Math.exp(-elapsedSeconds / timeConstantSeconds);
}

/** Varias lecturas de la misma banda (una por constelación) se promedian. */
export function averageAutomaticGainControlByBand(
  readings: readonly AutomaticGainControlReading[],
): Map<CarrierBandId, number> {
  const sumsByBand = new Map<CarrierBandId, { levelSumDb: number; readingCount: number }>();
  for (const reading of readings) {
    if (!Number.isFinite(reading.levelDb)) continue;
    const bandSums = sumsByBand.get(reading.bandId) ?? { levelSumDb: 0, readingCount: 0 };
    bandSums.levelSumDb += reading.levelDb;
    bandSums.readingCount += 1;
    sumsByBand.set(reading.bandId, bandSums);
  }
  return new Map(
    [...sumsByBand].map(([bandId, bandSums]) => [bandId, bandSums.levelSumDb / bandSums.readingCount] as const),
  );
}

export class InterferenceDetector {
  private readonly options: InterferenceDetectorOptions;
  private readonly signalQuantities = new Map<string, TrackedQuantity>();
  private readonly automaticGainControlQuantities = new Map<CarrierBandId, TrackedQuantity>();
  private learningStartedSeconds: number | null = null;
  private lastTimestampSeconds: number | null = null;
  private alertStartedSeconds: number | null = null;

  constructor(options: Partial<InterferenceDetectorOptions> = {}) {
    this.options = { ...defaultInterferenceDetectorOptions, ...options };
  }

  reset(): void {
    this.signalQuantities.clear();
    this.automaticGainControlQuantities.clear();
    this.learningStartedSeconds = null;
    this.lastTimestampSeconds = null;
    this.alertStartedSeconds = null;
  }

  update(epoch: InterferenceEpoch): InterferenceAssessment {
    const { timestampSeconds } = epoch;
    const elapsedSeconds =
      this.lastTimestampSeconds === null ? 0 : Math.min(5, Math.max(0, timestampSeconds - this.lastTimestampSeconds));
    this.lastTimestampSeconds = timestampSeconds;
    if (this.learningStartedSeconds === null) this.learningStartedSeconds = timestampSeconds;

    // Una alarma demasiado larga probablemente es el nuevo entorno: se vuelve a aprender.
    if (
      this.alertStartedSeconds !== null &&
      timestampSeconds - this.alertStartedSeconds > this.options.maximumFrozenBaselineSeconds
    ) {
      this.signalQuantities.clear();
      this.automaticGainControlQuantities.clear();
      this.learningStartedSeconds = timestampSeconds;
      this.alertStartedSeconds = null;
    }
    const isBaselineFrozen = this.alertStartedSeconds !== null;

    for (const observation of epoch.observations) {
      if (!isTracked(observation)) continue;
      this.updateQuantity(
        this.signalQuantities,
        signalKey(observation),
        observation.carrierToNoiseDensityDbHz,
        timestampSeconds,
        elapsedSeconds,
        isBaselineFrozen,
      );
    }
    for (const [bandId, levelDb] of averageAutomaticGainControlByBand(epoch.automaticGainControlReadings)) {
      this.updateQuantity(
        this.automaticGainControlQuantities,
        bandId,
        levelDb,
        timestampSeconds,
        elapsedSeconds,
        isBaselineFrozen,
      );
    }
    this.forgetStaleQuantities(timestampSeconds);

    const assessment = this.assess(timestampSeconds, isBaselineFrozen);
    if (assessment.level === 'none') this.alertStartedSeconds = null;
    else if (this.alertStartedSeconds === null) this.alertStartedSeconds = timestampSeconds;
    return assessment;
  }

  private updateQuantity<TKey>(
    quantities: Map<TKey, TrackedQuantity>,
    quantityKey: TKey,
    measuredValue: number,
    timestampSeconds: number,
    elapsedSeconds: number,
    isBaselineFrozen: boolean,
  ): void {
    const existingQuantity = quantities.get(quantityKey);
    if (!existingQuantity) {
      quantities.set(quantityKey, {
        // Una señal que aparece durante una alarma no tiene referencia fiable: no se compara.
        baselineValue: isBaselineFrozen ? null : measuredValue,
        baselineAgeSeconds: 0,
        currentValue: measuredValue,
        lastSeenSeconds: timestampSeconds,
      });
      return;
    }
    const stepSeconds = Math.min(elapsedSeconds, Math.max(0, timestampSeconds - existingQuantity.lastSeenSeconds));
    const currentWeight = exponentialSmoothingWeight(stepSeconds, this.options.currentTimeConstantSeconds);
    existingQuantity.currentValue += currentWeight * (measuredValue - existingQuantity.currentValue);
    if (!isBaselineFrozen) {
      if (existingQuantity.baselineValue === null) {
        existingQuantity.baselineValue = existingQuantity.currentValue;
        existingQuantity.baselineAgeSeconds = 0;
      } else {
        const baselineWeight = exponentialSmoothingWeight(stepSeconds, this.options.baselineTimeConstantSeconds);
        existingQuantity.baselineValue += baselineWeight * (measuredValue - existingQuantity.baselineValue);
        existingQuantity.baselineAgeSeconds += stepSeconds;
      }
    }
    existingQuantity.lastSeenSeconds = timestampSeconds;
  }

  private forgetStaleQuantities(timestampSeconds: number): void {
    for (const quantities of [this.signalQuantities, this.automaticGainControlQuantities] as Map<unknown, TrackedQuantity>[]) {
      for (const [quantityKey, quantity] of quantities) {
        if (timestampSeconds - quantity.lastSeenSeconds > this.options.forgetAfterSeconds) quantities.delete(quantityKey);
      }
    }
  }

  private hasUsableBaseline(quantity: TrackedQuantity): quantity is TrackedQuantity & { baselineValue: number } {
    return quantity.baselineValue !== null && quantity.baselineAgeSeconds >= this.options.minimumBaselineAgeSeconds;
  }

  private assess(timestampSeconds: number, isBaselineFrozen: boolean): InterferenceAssessment {
    const learningElapsedSeconds = timestampSeconds - (this.learningStartedSeconds ?? timestampSeconds);
    const learningProgress = Math.min(1, learningElapsedSeconds / this.options.warmUpSeconds);
    const hasAutomaticGainControlData = this.automaticGainControlQuantities.size > 0;

    const baselineSignals = [...this.signalQuantities.values()].filter((quantity) => this.hasUsableBaseline(quantity));
    const commonSignals = baselineSignals.filter((quantity) => quantity.lastSeenSeconds === timestampSeconds);
    const carrierToNoiseDrops = commonSignals.map((quantity) => (quantity.baselineValue as number) - quantity.currentValue);
    const medianCarrierToNoiseDropDb = median(carrierToNoiseDrops);
    const droppedSignalFraction =
      carrierToNoiseDrops.length > 0
        ? carrierToNoiseDrops.filter((dropDb) => dropDb >= this.options.perSignalCarrierToNoiseDropDb).length /
          carrierToNoiseDrops.length
        : null;
    const retainedSignalFraction = baselineSignals.length > 0 ? commonSignals.length / baselineSignals.length : null;

    const automaticGainControlDrops: AutomaticGainControlDrop[] = [];
    for (const [bandId, quantity] of this.automaticGainControlQuantities) {
      // Solo bandas con dato reciente (el AGC llega con las medidas crudas, no con cada época).
      if (!this.hasUsableBaseline(quantity) || timestampSeconds - quantity.lastSeenSeconds > 3) continue;
      automaticGainControlDrops.push({
        bandId,
        baselineLevelDb: quantity.baselineValue,
        currentLevelDb: quantity.currentValue,
        dropDb: quantity.baselineValue - quantity.currentValue,
      });
    }

    const isMonitoring = learningProgress >= 1;
    const isSkyStable =
      retainedSignalFraction !== null && retainedSignalFraction >= this.options.stableSkyRetainedFraction;
    const isMassSignalLoss =
      baselineSignals.length >= this.options.minimumCommonSignals &&
      retainedSignalFraction !== null &&
      retainedSignalFraction < this.options.massLossRetainedFraction;
    const isCarrierToNoiseDropUniform =
      commonSignals.length >= this.options.minimumCommonSignals &&
      medianCarrierToNoiseDropDb !== null &&
      medianCarrierToNoiseDropDb >= this.options.medianCarrierToNoiseDropDb &&
      droppedSignalFraction !== null &&
      droppedSignalFraction >= this.options.uniformDropFraction;
    const isAutomaticGainControlDropping = automaticGainControlDrops.some(
      (agcDrop) => agcDrop.dropDb >= this.options.automaticGainControlDropDb,
    );

    let level: InterferenceLevel = 'none';
    if (isMonitoring) {
      if (isAutomaticGainControlDropping && (isCarrierToNoiseDropUniform || isMassSignalLoss)) level = 'likely';
      else if (isAutomaticGainControlDropping) level = 'possible';
      else if (isCarrierToNoiseDropUniform && isSkyStable) level = 'possible';
    }

    return {
      status: isMonitoring ? 'monitoring' : 'learning',
      learningProgress,
      level,
      commonSignalCount: commonSignals.length,
      medianCarrierToNoiseDropDb,
      droppedSignalFraction,
      retainedSignalFraction,
      isSkyStable,
      isCarrierToNoiseDropUniform,
      isMassSignalLoss,
      hasAutomaticGainControlData,
      automaticGainControlDrops,
      isAutomaticGainControlDropping,
      isBaselineFrozen,
    };
  }
}
