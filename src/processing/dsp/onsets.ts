/**
 * Detección de golpes (onsets) por flujo espectral y estimación de tempo.
 *
 * Un golpe (palmada, nota nueva, paso) aparece como un aumento brusco de energía en muchas
 * frecuencias a la vez. El flujo espectral mide, trama a trama, cuánto ha crecido el espectro
 * respecto a la trama anterior; los picos de esa curva son los golpes.
 */

import { createFftPlan } from './fft';
import { computeAmplitudeSpectrum, createSpectrumWorkspace } from './spectrum';
import { createWindow } from './windows';

export interface SpectralFluxOptions {
  /** Muestras por trama de análisis (potencia de 2). 1024 a 44,1 kHz son unos 23 ms. */
  frameSize?: number;
  /** Avance entre tramas en muestras. Fija la resolución temporal de los golpes. */
  hopSize?: number;
  /**
   * Compresión logarítmica log(1 + γ·|X|): iguala golpes suaves y fuertes para que un
   * aplauso lejano no quede tapado por uno cercano.
   */
  logCompression?: number;
}

export interface SpectralFlux {
  fluxValues: Float64Array;
  /** Tiempo entre valores consecutivos de `fluxValues`. */
  hopSeconds: number;
  /** Instante (s) al que corresponde el valor 0: el centro de la primera trama. */
  firstFrameCenterSeconds: number;
}

const defaultFrameSize = 1024;
const defaultHopSize = 512;
const defaultLogCompression = 100;

/** Estado reutilizable para calcular el flujo trama a trama sin reservar memoria. */
function createFluxCalculator(frameSize: number, logCompression: number) {
  const plan = createFftPlan(frameSize);
  const analysisWindow = createWindow('hann', frameSize);
  const workspace = createSpectrumWorkspace(frameSize);
  const previousCompressedMagnitudes = new Float64Array(frameSize / 2 + 1);
  let hasPreviousFrame = false;
  return {
    /** Flujo de la trama `frameSamples` (longitud `frameSize`) respecto a la anterior. */
    next(frameSamples: ArrayLike<number>): number {
      const magnitudes = computeAmplitudeSpectrum(
        plan,
        frameSamples,
        analysisWindow.coefficients,
        analysisWindow.coherentGain,
        workspace,
      );
      let rectifiedIncrementSum = 0;
      for (let binIndex = 0; binIndex < magnitudes.length; binIndex++) {
        const compressedMagnitude = Math.log1p(logCompression * magnitudes[binIndex]!);
        // Solo cuentan los aumentos: el final de un sonido no es un golpe.
        if (hasPreviousFrame) {
          rectifiedIncrementSum += Math.max(0, compressedMagnitude - previousCompressedMagnitudes[binIndex]!);
        }
        previousCompressedMagnitudes[binIndex] = compressedMagnitude;
      }
      hasPreviousFrame = true;
      return rectifiedIncrementSum;
    },
    reset(): void {
      hasPreviousFrame = false;
    },
  };
}

export function computeSpectralFlux(
  samples: ArrayLike<number>,
  sampleRateHz: number,
  options: SpectralFluxOptions = {},
): SpectralFlux {
  const { frameSize = defaultFrameSize, hopSize = defaultHopSize, logCompression = defaultLogCompression } = options;
  if (!(hopSize > 0 && hopSize <= frameSize)) throw new RangeError(`hopSize debe estar en (0, frameSize]: ${hopSize}`);

  const frameCount = samples.length >= frameSize ? Math.floor((samples.length - frameSize) / hopSize) + 1 : 0;
  const fluxValues = new Float64Array(frameCount);
  const fluxCalculator = createFluxCalculator(frameSize, logCompression);
  const frameBuffer = new Float64Array(frameSize);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const frameStart = frameIndex * hopSize;
    for (let offset = 0; offset < frameSize; offset++) frameBuffer[offset] = samples[frameStart + offset]!;
    fluxValues[frameIndex] = fluxCalculator.next(frameBuffer);
  }
  return {
    fluxValues,
    hopSeconds: hopSize / sampleRateHz,
    firstFrameCenterSeconds: frameSize / 2 / sampleRateHz,
  };
}

export interface OnsetPickingOptions {
  /**
   * Cuánto debe superar un pico a la media local, como fracción del rango del flujo.
   * Más alto = menos falsos positivos y más golpes suaves perdidos.
   */
  thresholdOffset?: number;
  /** Ventana (s) a cada lado para la media local y para exigir máximo local. */
  localWindowSeconds?: number;
  /** Separación mínima entre golpes (s). 0,05 s permite redobles de hasta 20 golpes/s. */
  minimumIntervalSeconds?: number;
  /**
   * Flujo mínimo absoluto. El umbral relativo por sí solo convierte en golpes las pequeñas
   * fluctuaciones de una señal estable (un tono sostenido, un ventilador).
   */
  minimumFlux?: number;
}

/**
 * Elige los golpes en una curva de flujo: máximos locales por encima de un umbral adaptativo
 * (media local + desplazamiento). El umbral adaptativo evita que un fondo ruidoso dispare
 * golpes continuos y que una zona tranquila los pierda.
 */
export function pickOnsets(spectralFlux: SpectralFlux, options: OnsetPickingOptions = {}): number[] {
  const { thresholdOffset = 0.1, localWindowSeconds = 0.1, minimumIntervalSeconds = 0.05, minimumFlux = 1 } = options;
  const { fluxValues, hopSeconds, firstFrameCenterSeconds } = spectralFlux;
  if (fluxValues.length === 0) return [];

  let lowestFlux = Infinity;
  let highestFlux = -Infinity;
  for (const fluxValue of fluxValues) {
    lowestFlux = Math.min(lowestFlux, fluxValue);
    highestFlux = Math.max(highestFlux, fluxValue);
  }
  const fluxRange = highestFlux - lowestFlux;
  if (fluxRange <= 0) return [];

  const localWindowFrames = Math.max(1, Math.round(localWindowSeconds / hopSeconds));
  const minimumIntervalFrames = minimumIntervalSeconds / hopSeconds;
  const onsetTimesSeconds: number[] = [];
  let lastOnsetFrame = -Infinity;

  for (let frameIndex = 0; frameIndex < fluxValues.length; frameIndex++) {
    const firstNeighbor = Math.max(0, frameIndex - localWindowFrames);
    const lastNeighbor = Math.min(fluxValues.length - 1, frameIndex + localWindowFrames);
    const currentFlux = fluxValues[frameIndex]!;

    let neighborSum = 0;
    let isLocalMaximum = true;
    for (let neighborIndex = firstNeighbor; neighborIndex <= lastNeighbor; neighborIndex++) {
      const neighborFlux = fluxValues[neighborIndex]!;
      neighborSum += neighborFlux;
      // En una meseta gana la primera trama, como en detectPeaks.
      if (neighborFlux > currentFlux || (neighborFlux === currentFlux && neighborIndex < frameIndex)) {
        isLocalMaximum = false;
      }
    }
    if (!isLocalMaximum) continue;

    const localMean = neighborSum / (lastNeighbor - firstNeighbor + 1);
    const adaptiveThreshold = localMean + thresholdOffset * fluxRange;
    if (currentFlux < adaptiveThreshold || currentFlux < minimumFlux) continue;
    if (frameIndex - lastOnsetFrame < minimumIntervalFrames) continue;

    onsetTimesSeconds.push(firstFrameCenterSeconds + frameIndex * hopSeconds);
    lastOnsetFrame = frameIndex;
  }
  return onsetTimesSeconds;
}

/** Instantes (s) de los golpes de una grabación completa. */
export function detectOnsets(
  samples: ArrayLike<number>,
  sampleRateHz: number,
  options: SpectralFluxOptions & OnsetPickingOptions = {},
): number[] {
  return pickOnsets(computeSpectralFlux(samples, sampleRateHz, options), options);
}

export interface LiveOnsetDetectorOptions {
  sampleRateHz: number;
  frameSize?: number;
  logCompression?: number;
  /** Historia (s) con la que se calcula el umbral: solo mira al pasado, sirve en tiempo real. */
  historySeconds?: number;
  /** Desviaciones típicas por encima de la media de la historia para aceptar un golpe. */
  sensitivityStandardDeviations?: number;
  /** Flujo mínimo absoluto: evita disparos en silencio, donde la desviación típica es ~0. */
  minimumFlux?: number;
  minimumIntervalSeconds?: number;
}

/**
 * Detector causal para el micrófono en directo: se le pasa cada trama nueva (con el solape que
 * se quiera) y dice si empieza un golpe. Como no ve el futuro, usa media y desviación típica
 * del pasado reciente en lugar de exigir máximo local.
 */
export function createLiveOnsetDetector(options: LiveOnsetDetectorOptions) {
  const {
    sampleRateHz,
    frameSize = defaultFrameSize,
    logCompression = defaultLogCompression,
    historySeconds = 1,
    sensitivityStandardDeviations = 3,
    minimumFlux = 1,
    minimumIntervalSeconds = 0.08,
  } = options;
  const fluxCalculator = createFluxCalculator(frameSize, logCompression);
  let elapsedSamples = 0;
  let lastOnsetSeconds = -Infinity;
  let fluxHistory: { timeSeconds: number; fluxValue: number }[] = [];

  return {
    /**
     * `frameSamples` debe tener `frameSize` muestras; `advanceSamples` es cuánto ha avanzado el
     * audio desde la trama anterior. Devuelve el instante del golpe (s) o `null`.
     */
    push(frameSamples: ArrayLike<number>, advanceSamples: number): number | null {
      elapsedSamples += advanceSamples;
      const frameCenterSeconds = (elapsedSamples - frameSize / 2) / sampleRateHz;
      const currentFlux = fluxCalculator.next(frameSamples);

      fluxHistory = fluxHistory.filter((historyEntry) => frameCenterSeconds - historyEntry.timeSeconds <= historySeconds);
      let isOnset = false;
      if (fluxHistory.length >= 3) {
        let historySum = 0;
        for (const historyEntry of fluxHistory) historySum += historyEntry.fluxValue;
        const historyMean = historySum / fluxHistory.length;
        let squaredDeviationSum = 0;
        for (const historyEntry of fluxHistory) squaredDeviationSum += (historyEntry.fluxValue - historyMean) ** 2;
        const historyStandardDeviation = Math.sqrt(squaredDeviationSum / fluxHistory.length);
        isOnset =
          currentFlux >= minimumFlux &&
          currentFlux > historyMean + sensitivityStandardDeviations * historyStandardDeviation &&
          frameCenterSeconds - lastOnsetSeconds >= minimumIntervalSeconds;
      }
      fluxHistory.push({ timeSeconds: frameCenterSeconds, fluxValue: currentFlux });
      if (!isOnset) return null;
      lastOnsetSeconds = frameCenterSeconds;
      return frameCenterSeconds;
    },
    reset(): void {
      fluxCalculator.reset();
      elapsedSamples = 0;
      lastOnsetSeconds = -Infinity;
      fluxHistory = [];
    },
  };
}

export interface TempoEstimate {
  beatsPerMinute: number;
  /** Fracción (0–1) de intervalos que encajan con el tempo estimado o con sus múltiplos. */
  confidence: number;
}

export interface TempoEstimationOptions {
  minimumBeatsPerMinute?: number;
  maximumBeatsPerMinute?: number;
  /** Tolerancia relativa para que un intervalo cuente como coherente con el tempo. */
  intervalTolerance?: number;
}

/**
 * Tempo a partir de instantes de golpes (palmadas, pasos detectados con el acelerómetro…).
 * Usa la mediana de los intervalos entre golpes consecutivos, que ignora golpes sueltos, y la
 * lleva al rango pedido doblando o partiendo por la mitad (el clásico error de octava).
 */
export function estimateTempo(
  eventTimesSeconds: readonly number[],
  options: TempoEstimationOptions = {},
): TempoEstimate | null {
  const { minimumBeatsPerMinute = 40, maximumBeatsPerMinute = 240, intervalTolerance = 0.1 } = options;
  if (!(maximumBeatsPerMinute >= 2 * minimumBeatsPerMinute)) {
    throw new RangeError('El rango de tempo debe abarcar al menos una octava (máximo ≥ 2 × mínimo)');
  }
  const intervalsSeconds: number[] = [];
  for (let eventIndex = 1; eventIndex < eventTimesSeconds.length; eventIndex++) {
    const intervalSeconds = eventTimesSeconds[eventIndex]! - eventTimesSeconds[eventIndex - 1]!;
    if (intervalSeconds > 0) intervalsSeconds.push(intervalSeconds);
  }
  if (intervalsSeconds.length === 0) return null;

  const sortedIntervals = [...intervalsSeconds].sort((leftInterval, rightInterval) => leftInterval - rightInterval);
  const middleIndex = Math.floor(sortedIntervals.length / 2);
  const medianIntervalSeconds =
    sortedIntervals.length % 2 === 1
      ? sortedIntervals[middleIndex]!
      : (sortedIntervals[middleIndex - 1]! + sortedIntervals[middleIndex]!) / 2;

  let beatsPerMinute = 60 / medianIntervalSeconds;
  while (beatsPerMinute < minimumBeatsPerMinute) beatsPerMinute *= 2;
  while (beatsPerMinute > maximumBeatsPerMinute) beatsPerMinute /= 2;

  const beatPeriodSeconds = 60 / beatsPerMinute;
  const coherentIntervalCount = intervalsSeconds.filter((intervalSeconds) => {
    // Un silencio de dos pulsos (o un golpe a contratiempo) sigue siendo coherente con el tempo.
    const beatMultiple = intervalSeconds / beatPeriodSeconds;
    const nearestMultiple = Math.max(0.5, Math.round(beatMultiple * 2) / 2);
    return Math.abs(beatMultiple - nearestMultiple) <= intervalTolerance * nearestMultiple;
  }).length;

  return { beatsPerMinute, confidence: coherentIntervalCount / intervalsSeconds.length };
}

export interface StreamingOnsetDetectorOptions extends LiveOnsetDetectorOptions {
  /** Avance entre tramas en muestras: fija la resolución temporal (128 a 48 kHz ≈ 2,7 ms). */
  hopSize?: number;
}

/**
 * Detector en directo que acepta bloques de audio de cualquier tamaño (los que entregue el
 * micrófono) y los trocea en tramas solapadas. Los instantes se dan en segundos desde la
 * primera muestra recibida: la línea de tiempo del micrófono.
 */
export function createStreamingOnsetDetector(options: StreamingOnsetDetectorOptions) {
  const { frameSize = defaultFrameSize, hopSize = defaultHopSize } = options;
  if (!(hopSize > 0 && hopSize <= frameSize)) throw new RangeError(`hopSize debe estar en (0, frameSize]: ${hopSize}`);
  const liveDetector = createLiveOnsetDetector({ ...options, frameSize });
  // Buffer circular con las últimas `frameSize` muestras.
  const recentSamples = new Float64Array(frameSize);
  const frameBuffer = new Float64Array(frameSize);
  let writeIndex = 0;
  let receivedSampleCount = 0;
  let samplesSinceLastFrame = 0;

  return {
    /** Devuelve los instantes (s) de los golpes que empiezan en este bloque. */
    pushSamples(sampleChunk: ArrayLike<number>): number[] {
      const onsetTimesSeconds: number[] = [];
      for (let chunkIndex = 0; chunkIndex < sampleChunk.length; chunkIndex++) {
        recentSamples[writeIndex] = sampleChunk[chunkIndex]!;
        writeIndex = (writeIndex + 1) % frameSize;
        receivedSampleCount++;
        samplesSinceLastFrame++;
        if (receivedSampleCount < frameSize || samplesSinceLastFrame < hopSize) continue;
        // `writeIndex` apunta ahora a la muestra más antigua del buffer circular.
        for (let frameOffset = 0; frameOffset < frameSize; frameOffset++) {
          frameBuffer[frameOffset] = recentSamples[(writeIndex + frameOffset) % frameSize]!;
        }
        const onsetTimeSeconds = liveDetector.push(frameBuffer, samplesSinceLastFrame);
        samplesSinceLastFrame = 0;
        if (onsetTimeSeconds !== null) onsetTimesSeconds.push(onsetTimeSeconds);
      }
      return onsetTimesSeconds;
    },
    reset(): void {
      liveDetector.reset();
      recentSamples.fill(0);
      writeIndex = 0;
      receivedSampleCount = 0;
      samplesSinceLastFrame = 0;
    },
  };
}
