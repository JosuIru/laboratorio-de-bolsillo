import { useCallback, useEffect, useRef, useState } from 'react';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { type BiquadCoefficients, type BiquadState, createBiquadState, designBiquad, processBiquadSample } from '@/processing/dsp/biquad';
import { createEventDetector } from '@/processing/dsp/peaks';
import { estimateSampleRateHz } from '@/processing/signal/resampling';
import {
  clearRingBuffer,
  copyLatestFromRingBuffer,
  createRingBuffer,
  pushToRingBuffer,
  type RingBuffer,
} from '@/processing/signal/ringBuffer';

import { createVibrationAnalyzer, type VibrationAnalysis } from './vibrationAnalysis';

/** Capacidad del historial: ~20 s a 200 Hz. */
const historyCapacity = 4096;
/** Pedimos la máxima frecuencia; el sistema entrega lo que el sensor permite (100-500 Hz). */
const requestedRateHz = 250;
/** Frecuencia de corte del paso alto que quita la gravedad en las trazas. */
const gravityRemovalCutoffHz = 0.5;
const fftSize = 512;
const displayRefreshIntervalMilliseconds = 40;
const analysisIntervalMilliseconds = 500;

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
}

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
  const eventDetector = useRef(createEventDetector(eventThreshold, eventThreshold / 2));
  const eventCount = useRef(0);
  const recordingStartTimestamp = useRef<number | null>(null);
  const latestTimestamp = useRef<number | null>(null);

  const [displaySnapshot, setDisplaySnapshot] = useState({ revision: 0, eventCount: 0, durationSeconds: 0 });
  const [vibrationAnalysis, setVibrationAnalysis] = useState<VibrationAnalysis | null>(null);

  useEffect(() => {
    eventDetector.current = createEventDetector(eventThreshold, eventThreshold / 2);
  }, [eventThreshold]);

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      recordingStartTimestamp.current ??= timestampSeconds;
      latestTimestamp.current = timestampSeconds;
      pushToRingBuffer(history.timestamps, timestampSeconds);
      pushToRingBuffer(history.rawX, value.x);
      pushToRingBuffer(history.rawY, value.y);
      pushToRingBuffer(history.rawZ, value.z);

      const { coefficients, axisStates } = gravityFilters.current;
      const dynamicX = processBiquadSample(coefficients, axisStates[0], value.x);
      const dynamicY = processBiquadSample(coefficients, axisStates[1], value.y);
      const dynamicZ = processBiquadSample(coefficients, axisStates[2], value.z);
      pushToRingBuffer(history.dynamicX, dynamicX);
      pushToRingBuffer(history.dynamicY, dynamicY);
      pushToRingBuffer(history.dynamicZ, dynamicZ);

      // El filtro tarda unos segundos en asentarse: no se cuentan eventos hasta entonces.
      const hasFilterSettled = timestampSeconds - recordingStartTimestamp.current > 3;
      if (hasFilterSettled && eventDetector.current.push(Math.hypot(dynamicX, dynamicY, dynamicZ))) {
        eventCount.current++;
      }
    },
    { isActive: isRunning, targetRateHz: requestedRateHz },
  );

  useEffect(() => {
    if (!isRunning) return;
    const displayTimer = setInterval(
      () =>
        setDisplaySnapshot((previousSnapshot) => ({
          revision: previousSnapshot.revision + 1,
          eventCount: eventCount.current,
          durationSeconds:
            recordingStartTimestamp.current !== null && latestTimestamp.current !== null
              ? latestTimestamp.current - recordingStartTimestamp.current
              : 0,
        })),
      displayRefreshIntervalMilliseconds,
    );
    const analysisTimer = setInterval(() => {
      const recentCount = Math.min(history.timestamps.storedCount, Math.round(fftSize * 1.5));
      if (recentCount < 64) return;
      const recentTimestamps = new Float64Array(recentCount);
      copyLatestFromRingBuffer(history.timestamps, recentTimestamps);
      const measuredRateHz = estimateSampleRateHz(recentTimestamps);
      // Rediseña el filtro de gravedad si la frecuencia real difiere de la supuesta.
      if (measuredRateHz && Math.abs(measuredRateHz - gravityFilters.current.sampleRateHz) > 5) {
        gravityFilters.current = {
          ...createGravityFilters(measuredRateHz),
          axisStates: gravityFilters.current.axisStates,
        };
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
    setVibrationAnalysis(null);
    setDisplaySnapshot((previousSnapshot) => ({ revision: previousSnapshot.revision + 1, eventCount: 0, durationSeconds: 0 }));
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
    vibrationAnalysis,
    readLatest,
    reset,
  };
}
