/**
 * Detección de la llegada de una onda (la «onda P» del aula) sobre el acelerómetro.
 *
 * Es el método clásico de las redes sísmicas en dos pasos:
 * 1. Disparo STA/LTA: se compara la energía media de las últimas centésimas de segundo
 *    (STA, short-term average) con la de el último segundo (LTA, long-term average). Cuando el
 *    cociente sube de golpe, ha llegado algo que no es el ruido de fondo.
 * 2. Afinado con el criterio de Akaike (AIC, método de Maeda): alrededor del disparo se busca
 *    el instante que mejor parte la señal en «ruido» y «onda». El disparo llega siempre algo
 *    tarde (el STA tiene que llenarse); el AIC recupera el comienzo real.
 *
 * Todo trabaja con marcas de tiempo reales (el muestreo de Android no es perfectamente
 * regular), así que las medias recursivas usan el intervalo entre muestras.
 */

import {
  clearRingBuffer,
  copyLatestFromRingBuffer,
  createRingBuffer,
  pushToRingBuffer,
  type RingBuffer,
} from '../signal/ringBuffer';

export interface RecursiveStaLtaOptions {
  /** Constante de tiempo de la media corta. Unas pocas muestras: 20 ms. */
  shortWindowSeconds: number;
  /** Constante de tiempo de la media larga (el «ruido de fondo»). Del orden de 1 s. */
  longWindowSeconds: number;
  /** Nivel mínimo de la media larga, para que un sensor muy silencioso no dispare con nada. */
  minimumLongTermLevel?: number;
}

export interface RecursiveStaLta {
  /** Añade un valor de la función característica y devuelve el cociente STA/LTA. */
  push(characteristicValue: number, intervalSeconds: number): number;
  /** Congela la media larga (mientras pasa la onda, para que no se «acostumbre» a ella). */
  setLongTermFrozen(isFrozen: boolean): void;
  reset(): void;
  /** Tiempo acumulado desde el último reinicio: la media larga no vale hasta llenarse. */
  readonly elapsedSeconds: number;
  readonly shortTermLevel: number;
  readonly longTermLevel: number;
}

/** STA/LTA recursivo (medias exponenciales), válido con muestreo irregular. */
export function createRecursiveStaLta(options: RecursiveStaLtaOptions): RecursiveStaLta {
  const { shortWindowSeconds, longWindowSeconds, minimumLongTermLevel = 0 } = options;
  let shortTermLevel = 0;
  let longTermLevel = 0;
  let elapsedSeconds = 0;
  let hasFirstValue = false;
  let isLongTermFrozen = false;

  return {
    push(characteristicValue, intervalSeconds) {
      if (!hasFirstValue) {
        shortTermLevel = characteristicValue;
        longTermLevel = characteristicValue;
        hasFirstValue = true;
      } else {
        const safeIntervalSeconds = Math.max(0, intervalSeconds);
        elapsedSeconds += safeIntervalSeconds;
        const shortWeight = 1 - Math.exp(-safeIntervalSeconds / shortWindowSeconds);
        shortTermLevel += shortWeight * (characteristicValue - shortTermLevel);
        if (!isLongTermFrozen) {
          const longWeight = 1 - Math.exp(-safeIntervalSeconds / longWindowSeconds);
          longTermLevel += longWeight * (characteristicValue - longTermLevel);
        }
      }
      const denominator = Math.max(longTermLevel, minimumLongTermLevel, Number.MIN_VALUE);
      return shortTermLevel / denominator;
    },
    setLongTermFrozen(isFrozen) {
      isLongTermFrozen = isFrozen;
    },
    reset() {
      shortTermLevel = 0;
      longTermLevel = 0;
      elapsedSeconds = 0;
      hasFirstValue = false;
      isLongTermFrozen = false;
    },
    get elapsedSeconds() {
      return elapsedSeconds;
    },
    get shortTermLevel() {
      return shortTermLevel;
    },
    get longTermLevel() {
      return longTermLevel;
    },
  };
}

/**
 * Selector de llegada por AIC (Maeda, 1985), generalizado a varios canales (los tres ejes).
 *
 * AIC(k) = k·ln(varianza de [0, k)) + (N − k)·ln(varianza de [k, N)). El mínimo marca el
 * índice `k` en el que empieza la parte «nueva» de la señal. Devuelve ese índice, o `null`
 * si la ventana es demasiado corta.
 */
export function pickOnsetIndexByAic(
  channels: readonly ArrayLike<number>[],
  minimumSegmentLength = 3,
): number | null {
  const sampleCount = channels[0]?.length ?? 0;
  if (sampleCount < 2 * minimumSegmentLength) return null;

  // Sumas acumuladas de x y x² sumando los canales: varianza multicanal en O(1) por corte.
  const cumulativeSquares = new Float64Array(sampleCount + 1);
  const channelCount = channels.length;
  const channelSums = new Float64Array(channelCount);
  const prefixChannelSums: Float64Array[] = channels.map(() => new Float64Array(sampleCount + 1));
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    let squaresAtSample = 0;
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
      const sampleValue = channels[channelIndex]![sampleIndex]!;
      channelSums[channelIndex]! += sampleValue;
      prefixChannelSums[channelIndex]![sampleIndex + 1] = channelSums[channelIndex]!;
      squaresAtSample += sampleValue * sampleValue;
    }
    cumulativeSquares[sampleIndex + 1] = cumulativeSquares[sampleIndex]! + squaresAtSample;
  }

  /** Varianza multicanal (suma de las varianzas de cada eje) del tramo [startIndex, endIndex). */
  const segmentVariance = (startIndex: number, endIndex: number) => {
    const segmentLength = endIndex - startIndex;
    let squaredMeansSum = 0;
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
      const channelMean =
        (prefixChannelSums[channelIndex]![endIndex]! - prefixChannelSums[channelIndex]![startIndex]!) / segmentLength;
      squaredMeansSum += channelMean * channelMean;
    }
    const meanSquare = (cumulativeSquares[endIndex]! - cumulativeSquares[startIndex]!) / segmentLength;
    return Math.max(meanSquare - squaredMeansSum, 1e-30);
  };

  let bestSplitIndex: number | null = null;
  let lowestCriterion = Infinity;
  for (let splitIndex = minimumSegmentLength; splitIndex <= sampleCount - minimumSegmentLength; splitIndex++) {
    const criterion =
      splitIndex * Math.log(segmentVariance(0, splitIndex)) +
      (sampleCount - splitIndex) * Math.log(segmentVariance(splitIndex, sampleCount));
    if (criterion < lowestCriterion) {
      lowestCriterion = criterion;
      bestSplitIndex = splitIndex;
    }
  }
  return bestSplitIndex;
}

export interface OnsetDetectorOptions {
  shortWindowSeconds?: number;
  longWindowSeconds?: number;
  /** Cociente STA/LTA que dispara. Más alto = menos sensible. */
  triggerRatio?: number;
  /** Cociente por debajo del cual se vuelve a escuchar tras un evento. */
  detriggerRatio?: number;
  /** Nivel mínimo de la media larga, en (m/s²)² de la diferencia entre muestras. */
  minimumLongTermLevel?: number;
  /** Ventana antes del disparo en la que el AIC busca el comienzo. */
  preTriggerSeconds?: number;
  /** Cuánto se espera tras el disparo para tener onda suficiente para el AIC. */
  postTriggerSeconds?: number;
  /** Tiempo mínimo entre dos eventos (la «coda» de un golpe no es otro golpe). */
  refractorySeconds?: number;
  /** Si el ruido no baja (alguien sigue moviendo la mesa), se vuelve a escuchar tras este tiempo. */
  maximumCoolDownSeconds?: number;
  /** Hueco entre muestras a partir del cual se reinician las medias (app en pausa…). */
  maximumGapSeconds?: number;
  /** Muestras que se guardan para el AIC. Debe cubrir pre + post a la frecuencia máxima. */
  bufferCapacity?: number;
}

export interface OnsetPick {
  /** Instante de llegada estimado (reloj del sensor, en segundos). */
  onsetTimestampSeconds: number;
  /** Instante en que saltó el disparo STA/LTA (siempre ≥ la llegada). */
  triggerTimestampSeconds: number;
  /** Cociente STA/LTA máximo durante el evento: da idea de lo claro que fue. */
  peakRatio: number;
  /** Mayor salto entre muestras consecutivas en la ventana (m/s²). */
  peakAmplitude: number;
}

export type OnsetDetectorPhase = 'warming-up' | 'listening' | 'triggered' | 'cooling-down';

export interface OnsetDetector {
  /** Aceleración en m/s² (la gravedad no molesta: se trabaja con diferencias). */
  push(timestampSeconds: number, accelerationX: number, accelerationY: number, accelerationZ: number): OnsetPick | null;
  reset(): void;
  readonly phase: OnsetDetectorPhase;
  readonly currentRatio: number;
}

const defaultOnsetDetectorOptions: Required<OnsetDetectorOptions> = {
  shortWindowSeconds: 0.02,
  longWindowSeconds: 1,
  triggerRatio: 8,
  detriggerRatio: 2,
  minimumLongTermLevel: 1e-6,
  preTriggerSeconds: 0.25,
  postTriggerSeconds: 0.06,
  refractorySeconds: 0.8,
  maximumCoolDownSeconds: 3,
  maximumGapSeconds: 0.5,
  bufferCapacity: 1024,
};

/**
 * Detector en tiempo real: STA/LTA para disparar y AIC para fijar la llegada.
 *
 * La función característica es |Δa|², el cuadrado del salto de aceleración entre muestras
 * consecutivas: quita la gravedad y la inclinación sin filtros (que retrasarían la llegada
 * de forma distinta en cada móvil) y resalta el frente brusco de un golpe.
 */
export function createOnsetDetector(options: OnsetDetectorOptions = {}): OnsetDetector {
  const settings = { ...defaultOnsetDetectorOptions, ...options };
  const staLta = createRecursiveStaLta({
    shortWindowSeconds: settings.shortWindowSeconds,
    longWindowSeconds: settings.longWindowSeconds,
    minimumLongTermLevel: settings.minimumLongTermLevel,
  });
  const recentTimestamps: RingBuffer = createRingBuffer(settings.bufferCapacity);
  const recentDifferencesX: RingBuffer = createRingBuffer(settings.bufferCapacity);
  const recentDifferencesY: RingBuffer = createRingBuffer(settings.bufferCapacity);
  const recentDifferencesZ: RingBuffer = createRingBuffer(settings.bufferCapacity);

  let phase: OnsetDetectorPhase = 'warming-up';
  let currentRatio = 0;
  let previousSample: { timestampSeconds: number; x: number; y: number; z: number } | null = null;
  let triggerTimestampSeconds = 0;
  let peakRatioDuringEvent = 0;
  let refractoryEndSeconds = 0;

  function resetAll() {
    staLta.reset();
    for (const ringBuffer of [recentTimestamps, recentDifferencesX, recentDifferencesY, recentDifferencesZ]) {
      clearRingBuffer(ringBuffer);
    }
    phase = 'warming-up';
    currentRatio = 0;
    previousSample = null;
    peakRatioDuringEvent = 0;
  }

  function readRecentWindow(startTimestampSeconds: number) {
    const storedCount = recentTimestamps.storedCount;
    const timestamps = new Float64Array(storedCount);
    const differencesX = new Float64Array(storedCount);
    const differencesY = new Float64Array(storedCount);
    const differencesZ = new Float64Array(storedCount);
    copyLatestFromRingBuffer(recentTimestamps, timestamps);
    copyLatestFromRingBuffer(recentDifferencesX, differencesX);
    copyLatestFromRingBuffer(recentDifferencesY, differencesY);
    copyLatestFromRingBuffer(recentDifferencesZ, differencesZ);
    let firstIndex = 0;
    while (firstIndex < storedCount && timestamps[firstIndex]! < startTimestampSeconds) firstIndex++;
    return {
      timestamps: timestamps.subarray(firstIndex),
      differencesX: differencesX.subarray(firstIndex),
      differencesY: differencesY.subarray(firstIndex),
      differencesZ: differencesZ.subarray(firstIndex),
    };
  }

  function finishPick(): OnsetPick {
    const eventWindow = readRecentWindow(triggerTimestampSeconds - settings.preTriggerSeconds);
    const splitIndex = pickOnsetIndexByAic([eventWindow.differencesX, eventWindow.differencesY, eventWindow.differencesZ]);
    let onsetTimestampSeconds = triggerTimestampSeconds;
    if (splitIndex !== null) {
      // El AIC nunca puede poner la llegada después del disparo.
      onsetTimestampSeconds = Math.min(eventWindow.timestamps[splitIndex]!, triggerTimestampSeconds);
    }
    let peakAmplitude = 0;
    for (let sampleIndex = 0; sampleIndex < eventWindow.timestamps.length; sampleIndex++) {
      const jumpMagnitude = Math.hypot(
        eventWindow.differencesX[sampleIndex]!,
        eventWindow.differencesY[sampleIndex]!,
        eventWindow.differencesZ[sampleIndex]!,
      );
      if (jumpMagnitude > peakAmplitude) peakAmplitude = jumpMagnitude;
    }
    return {
      onsetTimestampSeconds,
      triggerTimestampSeconds,
      peakRatio: peakRatioDuringEvent,
      peakAmplitude,
    };
  }

  return {
    push(timestampSeconds, accelerationX, accelerationY, accelerationZ) {
      const lastSample = previousSample;
      previousSample = { timestampSeconds, x: accelerationX, y: accelerationY, z: accelerationZ };
      if (!lastSample) return null;
      const intervalSeconds = timestampSeconds - lastSample.timestampSeconds;
      if (intervalSeconds <= 0) return null;
      if (intervalSeconds > settings.maximumGapSeconds) {
        // Un hueco largo (pausa, cambio de pantalla): se vuelve a aprender el ruido de fondo.
        resetAll();
        previousSample = { timestampSeconds, x: accelerationX, y: accelerationY, z: accelerationZ };
        return null;
      }

      const differenceX = accelerationX - lastSample.x;
      const differenceY = accelerationY - lastSample.y;
      const differenceZ = accelerationZ - lastSample.z;
      pushToRingBuffer(recentTimestamps, timestampSeconds);
      pushToRingBuffer(recentDifferencesX, differenceX);
      pushToRingBuffer(recentDifferencesY, differenceY);
      pushToRingBuffer(recentDifferencesZ, differenceZ);
      const characteristicValue = differenceX * differenceX + differenceY * differenceY + differenceZ * differenceZ;
      currentRatio = staLta.push(characteristicValue, intervalSeconds);

      switch (phase) {
        case 'warming-up':
          if (staLta.elapsedSeconds >= settings.longWindowSeconds) phase = 'listening';
          return null;
        case 'listening':
          if (currentRatio >= settings.triggerRatio) {
            phase = 'triggered';
            triggerTimestampSeconds = timestampSeconds;
            peakRatioDuringEvent = currentRatio;
            staLta.setLongTermFrozen(true);
          }
          return null;
        case 'triggered':
          peakRatioDuringEvent = Math.max(peakRatioDuringEvent, currentRatio);
          if (timestampSeconds - triggerTimestampSeconds < settings.postTriggerSeconds) return null;
          phase = 'cooling-down';
          refractoryEndSeconds = triggerTimestampSeconds + settings.refractorySeconds;
          return finishPick();
        case 'cooling-down':
          const hasCoolDownExpired =
            timestampSeconds - triggerTimestampSeconds >= settings.refractorySeconds + settings.maximumCoolDownSeconds;
          if ((timestampSeconds >= refractoryEndSeconds && currentRatio < settings.detriggerRatio) || hasCoolDownExpired) {
            staLta.setLongTermFrozen(false);
            phase = 'listening';
          }
          return null;
      }
    },
    reset: resetAll,
    get phase() {
      return phase;
    },
    get currentRatio() {
      return currentRatio;
    },
  };
}
