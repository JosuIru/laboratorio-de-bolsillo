import { useCallback, useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';

import { magnetometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { createEventDetector } from '@/processing/dsp/peaks';
import {
  applyHardIronOffset,
  averageVectors,
  detectorThresholdsBySensitivity,
  type DetectorSensitivity,
  deviationFromBaseline,
  type HardIronOffset,
  type MagneticVector,
  vectorMagnitude,
} from '@/processing/magnetics/magneticField';
import { copyLatestFromRingBuffer, createRingBuffer, pushToRingBuffer } from '@/processing/signal/ringBuffer';

/** El magnetómetro de un móvil suele llegar a 50–100 Hz. */
const requestedRateHz = 100;
const displayRefreshIntervalMilliseconds = 50;
export const chartDurationSeconds = 10;
/** Suficiente para 10 s a 100 Hz. */
const historyCapacity = 1024;
/** Tiempo que se promedia para fijar la línea base al poner a cero. */
const zeroingDurationSeconds = 1;
const alertVibrationMilliseconds = 60;

export interface MagneticFieldSnapshot {
  revision: number;
  /** |B| corregido, en µT. */
  magnitudeMicroteslas: number | null;
  /** ΔB = |B − B0|, en µT; null mientras no hay línea base. */
  deviationMicroteslas: number | null;
  peakDeviationMicroteslas: number;
  baselineMagnitudeMicroteslas: number | null;
  isZeroing: boolean;
  isAboveThreshold: boolean;
  /** Últimos ~10 s de ΔB, de más antiguo a más reciente. */
  chartValues: Float64Array;
  chartSampleCount: number;
}

/**
 * Lee el magnetómetro, resta el campo propio del móvil (calibración) y mide la desviación
 * respecto a una línea base. Las muestras van a refs y la interfaz se refresca a ~20 fps.
 */
export function useMagneticField({
  isRunning,
  hardIronOffset,
  sensitivity,
  isVibrationEnabled,
}: {
  isRunning: boolean;
  hardIronOffset: HardIronOffset | null;
  sensitivity: DetectorSensitivity;
  isVibrationEnabled: boolean;
}) {
  const [deviationHistory] = useState(() => createRingBuffer(historyCapacity));
  const [timestampHistory] = useState(() => createRingBuffer(historyCapacity));
  const [chartValues] = useState(() => new Float64Array(historyCapacity));
  const latestVector = useRef<MagneticVector | null>(null);
  const latestDeviation = useRef<number | null>(null);
  const baselineVector = useRef<MagneticVector | null>(null);
  const peakDeviation = useRef(0);
  // Al arrancar se pone a cero solo: la primera lectura estable es la referencia.
  const zeroingSamples = useRef<MagneticVector[] | null>([]);
  const zeroingStartTimestamp = useRef<number | null>(null);
  const alertDetector = useRef(createEventDetector(
    detectorThresholdsBySensitivity[sensitivity].trigger,
    detectorThresholdsBySensitivity[sensitivity].release,
  ));
  const shouldVibrate = useRef(isVibrationEnabled);

  const [snapshot, setSnapshot] = useState<MagneticFieldSnapshot>({
    revision: 0,
    magnitudeMicroteslas: null,
    deviationMicroteslas: null,
    peakDeviationMicroteslas: 0,
    baselineMagnitudeMicroteslas: null,
    isZeroing: true,
    isAboveThreshold: false,
    chartValues,
    chartSampleCount: 0,
  });

  useEffect(() => {
    const { trigger, release } = detectorThresholdsBySensitivity[sensitivity];
    alertDetector.current = createEventDetector(trigger, release);
  }, [sensitivity]);
  useEffect(() => {
    shouldVibrate.current = isVibrationEnabled;
  }, [isVibrationEnabled]);
  // Con otra calibración cambia el campo corregido: la línea base anterior ya no sirve.
  const offsetX = hardIronOffset?.offsetX ?? 0;
  const offsetY = hardIronOffset?.offsetY ?? 0;
  const offsetZ = hardIronOffset?.offsetZ ?? 0;
  useEffect(() => {
    zeroingSamples.current = [];
    zeroingStartTimestamp.current = null;
    latestDeviation.current = null;
  }, [offsetX, offsetY, offsetZ]);

  useSensorSubscription(
    magnetometerSource,
    ({ timestampSeconds, value }) => {
      const correctedVector = applyHardIronOffset(value, hardIronOffset);
      latestVector.current = correctedVector;

      if (zeroingSamples.current) {
        zeroingStartTimestamp.current ??= timestampSeconds;
        zeroingSamples.current.push(correctedVector);
        if (timestampSeconds - zeroingStartTimestamp.current >= zeroingDurationSeconds) {
          baselineVector.current = averageVectors(zeroingSamples.current);
          zeroingSamples.current = null;
          zeroingStartTimestamp.current = null;
          peakDeviation.current = 0;
          alertDetector.current.reset();
        }
        return;
      }
      if (!baselineVector.current) return;

      const deviation = deviationFromBaseline(correctedVector, baselineVector.current);
      latestDeviation.current = deviation;
      peakDeviation.current = Math.max(peakDeviation.current, deviation);
      pushToRingBuffer(deviationHistory, deviation);
      pushToRingBuffer(timestampHistory, timestampSeconds);
      if (alertDetector.current.push(deviation) && shouldVibrate.current) Vibration.vibrate(alertVibrationMilliseconds);
    },
    { isActive: isRunning, targetRateHz: requestedRateHz },
  );

  useEffect(() => {
    if (!isRunning) return;
    const recentTimestamps = new Float64Array(historyCapacity);
    const displayTimer = setInterval(() => {
      // Cuántas de las muestras guardadas caen en los últimos 10 s.
      const storedCount = copyLatestFromRingBuffer(timestampHistory, recentTimestamps);
      const newestTimestamp = storedCount > 0 ? recentTimestamps[storedCount - 1]! : 0;
      let chartSampleCount = 0;
      while (
        chartSampleCount < storedCount &&
        newestTimestamp - recentTimestamps[storedCount - 1 - chartSampleCount]! <= chartDurationSeconds
      ) {
        chartSampleCount++;
      }
      copyLatestFromRingBuffer(deviationHistory, chartValues, chartSampleCount);
      const { trigger } = detectorThresholdsBySensitivity[sensitivity];
      setSnapshot((previousSnapshot) => ({
        revision: previousSnapshot.revision + 1,
        magnitudeMicroteslas: latestVector.current ? vectorMagnitude(latestVector.current) : null,
        deviationMicroteslas: zeroingSamples.current ? null : latestDeviation.current,
        peakDeviationMicroteslas: peakDeviation.current,
        baselineMagnitudeMicroteslas: baselineVector.current ? vectorMagnitude(baselineVector.current) : null,
        isZeroing: zeroingSamples.current !== null,
        isAboveThreshold: !zeroingSamples.current && (latestDeviation.current ?? 0) >= trigger,
        chartValues,
        chartSampleCount,
      }));
    }, displayRefreshIntervalMilliseconds);
    return () => clearInterval(displayTimer);
  }, [isRunning, sensitivity, deviationHistory, timestampHistory, chartValues]);

  /** Fija la línea base con la media del próximo segundo (hay que alejar el móvil del metal). */
  const zero = useCallback(() => {
    zeroingSamples.current = [];
    zeroingStartTimestamp.current = null;
    latestDeviation.current = null;
  }, []);

  return { snapshot, zero };
}
