import { useCallback, useEffect, useRef, useState } from 'react';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import {
  type BiquadCoefficients,
  type BiquadState,
  createBiquadState,
  designBiquad,
  primeBiquadState,
  processBiquadSample,
} from '@/processing/dsp/biquad';
import { createEventDetector } from '@/processing/dsp/peaks';
import { estimateSampleRateHz } from '@/processing/signal/resampling';
import {
  clearRingBuffer,
  copyLatestFromRingBuffer,
  createRingBuffer,
  pushToRingBuffer,
  type RingBuffer,
} from '@/processing/signal/ringBuffer';

import { createVibrationAnalyzer, type VibrationAnalysis } from '@/processing/dsp/vibrationAnalysis';

/** Capacidad del historial: ~20 s a 200 Hz. */
const historyCapacity = 4096;
/** Pedimos la máxima frecuencia; el sistema entrega lo que el sensor permite (100-500 Hz). */
const requestedRateHz = 250;
/** Frecuencia de corte del paso alto que quita la gravedad en las trazas. */
const gravityRemovalCutoffHz = 0.5;
const fftSize = 512;
const displayRefreshIntervalMilliseconds = 40;
const analysisIntervalMilliseconds = 500;
/** Hueco entre muestras (pausa, app en segundo plano) tras el que se vuelve a cebar el filtro. */
const maximumGapSeconds = 0.5;
/**
 * Un golpe hace vibrar la mesa (decenas de Hz) durante un rato y la señal cruza por cero en
 * cada ciclo: tras un evento no se cuenta otro en medio segundo, y solo se rearma cuando la
 * señal lleva un rato seguido por debajo del umbral de rearme.
 */
const eventTimingOptions = { refractorySeconds: 0.5, quietSecondsBeforeRearm: 0.2 } as const;

function createSeismographEventDetector(eventThreshold: number) {
  return createEventDetector(eventThreshold, eventThreshold / 2, eventTimingOptions);
}

export interface AccelerationHistory {
  timestamps: RingBuffer;
  rawX: RingBuffer;
  rawY: RingBuffer;
  rawZ: RingBuffer;
  dynamicX: RingBuffer;
  dynamicY: RingBuffer;
  dynamicZ: RingBuffer;
}

interface GravityFilters {
  sampleRateHz: number;
  coefficients: BiquadCoefficients;
  axisStates: [BiquadState, BiquadState, BiquadState];
  /** Si ya se cebó con una muestra real (ver `primeBiquadState`). */
  isPrimed: boolean;
}

const emptyDisplaySnapshot = {
  revision: 0,
  eventCount: 0,
  durationSeconds: 0,
  sessionPeakDynamicAcceleration: 0,
  sessionRmsDynamicAcceleration: 0,
};

function createHistory(): AccelerationHistory {
  return {
    timestamps: createRingBuffer(historyCapacity),
    rawX: createRingBuffer(historyCapacity),
    rawY: createRingBuffer(historyCapacity),
    rawZ: createRingBuffer(historyCapacity),
    dynamicX: createRingBuffer(historyCapacity),
    dynamicY: createRingBuffer(historyCapacity),
    dynamicZ: createRingBuffer(historyCapacity),
  };
}

function createGravityFilters(sampleRateHz: number): GravityFilters {
  return {
    sampleRateHz,
    coefficients: designBiquad('high-pass', gravityRemovalCutoffHz, sampleRateHz),
    axisStates: [createBiquadState(), createBiquadState(), createBiquadState()],
    isPrimed: false,
  };
}

/**
 * Registra el acelerómetro a la máxima frecuencia disponible. Las muestras se guardan en
 * buffers circulares (sin reservar memoria); la interfaz se refresca a ~25 fps y el análisis
 * espectral cada medio segundo, para no bloquear el hilo JS con cada muestra.
 */
export function useAccelerationRecorder({ isRunning, eventThreshold }: { isRunning: boolean; eventThreshold: number }) {
  const [history] = useState(createHistory);
  const [vibrationAnalyzer] = useState(() => createVibrationAnalyzer(fftSize));
  const gravityFilters = useRef<GravityFilters>(createGravityFilters(100));
  const eventDetector = useRef(createSeismographEventDetector(eventThreshold));
  const eventCount = useRef(0);
  const recordingStartTimestamp = useRef<number | null>(null);
  const latestTimestamp = useRef<number | null>(null);
  /**
   * Pico y valor eficaz del módulo de la aceleración dinámica en toda la sesión (desde el
   * último «Reiniciar»), para que lo guardado cubra el mismo tiempo que la duración y los
   * eventos. El análisis espectral solo mira los últimos segundos.
   */
  const sessionStatistics = useRef({ peakDynamicAcceleration: 0, sumOfSquares: 0, sampleCount: 0 });

  const [displaySnapshot, setDisplaySnapshot] = useState(emptyDisplaySnapshot);
  const [vibrationAnalysis, setVibrationAnalysis] = useState<VibrationAnalysis | null>(null);

  useEffect(() => {
    eventDetector.current = createSeismographEventDetector(eventThreshold);
  }, [eventThreshold]);

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      recordingStartTimestamp.current ??= timestampSeconds;
      const previousTimestamp = latestTimestamp.current;
      latestTimestamp.current = timestampSeconds;
      pushToRingBuffer(history.timestamps, timestampSeconds);
      pushToRingBuffer(history.rawX, value.x);
      pushToRingBuffer(history.rawY, value.y);
      pushToRingBuffer(history.rawZ, value.z);

      // El paso alto se ceba con la primera muestra (al empezar, tras reiniciar, tras una pausa o
      // al rediseñarlo): si arrancara en cero, la gravedad entraría como un escalón y daría un pico falso.
      const hasLongGap = previousTimestamp !== null && timestampSeconds - previousTimestamp > maximumGapSeconds;
      const { coefficients, axisStates } = gravityFilters.current;
      if (!gravityFilters.current.isPrimed || hasLongGap) {
        primeBiquadState(coefficients, axisStates[0], value.x);
        primeBiquadState(coefficients, axisStates[1], value.y);
        primeBiquadState(coefficients, axisStates[2], value.z);
        gravityFilters.current.isPrimed = true;
      }
      const dynamicX = processBiquadSample(coefficients, axisStates[0], value.x);
      const dynamicY = processBiquadSample(coefficients, axisStates[1], value.y);
      const dynamicZ = processBiquadSample(coefficients, axisStates[2], value.z);
      pushToRingBuffer(history.dynamicX, dynamicX);
      pushToRingBuffer(history.dynamicY, dynamicY);
      pushToRingBuffer(history.dynamicZ, dynamicZ);

      const dynamicMagnitude = Math.hypot(dynamicX, dynamicY, dynamicZ);
      const statistics = sessionStatistics.current;
      statistics.peakDynamicAcceleration = Math.max(statistics.peakDynamicAcceleration, dynamicMagnitude);
      statistics.sumOfSquares += dynamicMagnitude * dynamicMagnitude;
      statistics.sampleCount++;

      if (hasLongGap) eventDetector.current.reset();
      if (eventDetector.current.push(dynamicMagnitude, timestampSeconds)) {
        eventCount.current++;
      }
    },
    { isActive: isRunning, targetRateHz: requestedRateHz },
  );

  useEffect(() => {
    if (!isRunning) return;
    const displayTimer = setInterval(
      () =>
        setDisplaySnapshot((previousSnapshot) => {
          const statistics = sessionStatistics.current;
          return {
            revision: previousSnapshot.revision + 1,
            eventCount: eventCount.current,
            durationSeconds:
              recordingStartTimestamp.current !== null && latestTimestamp.current !== null
                ? latestTimestamp.current - recordingStartTimestamp.current
                : 0,
            sessionPeakDynamicAcceleration: statistics.peakDynamicAcceleration,
            sessionRmsDynamicAcceleration:
              statistics.sampleCount > 0 ? Math.sqrt(statistics.sumOfSquares / statistics.sampleCount) : 0,
          };
        }),
      displayRefreshIntervalMilliseconds,
    );
    const analysisTimer = setInterval(() => {
      const recentCount = Math.min(history.timestamps.storedCount, Math.round(fftSize * 1.5));
      if (recentCount < 64) return;
      const recentTimestamps = new Float64Array(recentCount);
      copyLatestFromRingBuffer(history.timestamps, recentTimestamps);
      const measuredRateHz = estimateSampleRateHz(recentTimestamps);
      // Rediseña el filtro de gravedad si la frecuencia real difiere de la supuesta. El estado
      // viejo no vale con los coeficientes nuevos (daría un salto): se vuelve a cebar.
      if (measuredRateHz && Math.abs(measuredRateHz - gravityFilters.current.sampleRateHz) > 5) {
        gravityFilters.current = createGravityFilters(measuredRateHz);
      }
      const copyAxis = (axisBuffer: RingBuffer) => {
        const axisValues = new Float64Array(recentCount);
        copyLatestFromRingBuffer(axisBuffer, axisValues);
        return axisValues;
      };
      setVibrationAnalysis(
        vibrationAnalyzer.analyze({
          timestampsSeconds: recentTimestamps,
          x: copyAxis(history.rawX),
          y: copyAxis(history.rawY),
          z: copyAxis(history.rawZ),
        }),
      );
    }, analysisIntervalMilliseconds);
    return () => {
      clearInterval(displayTimer);
      clearInterval(analysisTimer);
    };
  }, [isRunning, history, vibrationAnalyzer]);

  const reset = useCallback(() => {
    for (const ringBuffer of Object.values(history)) clearRingBuffer(ringBuffer);
    gravityFilters.current = createGravityFilters(gravityFilters.current.sampleRateHz);
    eventDetector.current.reset();
    eventCount.current = 0;
    recordingStartTimestamp.current = null;
    latestTimestamp.current = null;
    sessionStatistics.current = { peakDynamicAcceleration: 0, sumOfSquares: 0, sampleCount: 0 };
    setVibrationAnalysis(null);
    setDisplaySnapshot((previousSnapshot) => ({ ...emptyDisplaySnapshot, revision: previousSnapshot.revision + 1 }));
  }, [history]);

  /** Copia ordenada de las últimas `sampleCount` muestras de un buffer. */
  const readLatest = useCallback((ringBuffer: RingBuffer, sampleCount = ringBuffer.storedCount) => {
    const latestValues = new Float64Array(Math.min(sampleCount, ringBuffer.storedCount));
    copyLatestFromRingBuffer(ringBuffer, latestValues);
    return latestValues;
  }, []);

  return {
    history,
    displayRevision: displaySnapshot.revision,
    eventCount: displaySnapshot.eventCount,
    recordingDurationSeconds: displaySnapshot.durationSeconds,
    sessionPeakDynamicAcceleration: displaySnapshot.sessionPeakDynamicAcceleration,
    sessionRmsDynamicAcceleration: displaySnapshot.sessionRmsDynamicAcceleration,
    vibrationAnalysis,
    readLatest,
    reset,
  };
}
