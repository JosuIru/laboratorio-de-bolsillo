import { useCallback, useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';

import { magnetometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { createEventDetector } from '@/processing/dsp/peaks';
import {
  detectorThresholdsBySensitivity,
  type DetectorSensitivity,
  deviationFromBaseline,
  type MagneticVector,
  trackBaselineMagnitude,
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
/**
 * La línea base sigue despacio al campo: en ~30 s absorbe una deriva o el escalón de una
 * recalibración del sistema, y pasar el móvil sobre un objeto (1–2 s) apenas la mueve.
 */
const baselineTrackingTimeConstantSeconds = 30;
/**
 * Con el aviso encendido sigue aún más despacio: un objeto quieto bajo el móvil sigue avisando
 * durante minutos, pero un escalón mayor que el umbral no deja el aviso encendido para siempre.
 */
const baselineTrackingDuringAlertTimeConstantSeconds = 180;
/** Si llegan muestras tras una pausa larga, no se aplica de golpe todo el hueco a la línea base. */
const maximumTrackingStepSeconds = 0.5;

export interface MagneticFieldSnapshot {
  revision: number;
  /** |B| tal como lo entrega el sistema (ya compensado), en µT. */
  magnitudeMicroteslas: number | null;
  /** ΔB = ||B| − |B0||, en µT; null mientras no hay línea base. */
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
 * Lee el magnetómetro y mide cuánto se aparta el módulo del campo de una línea base que sigue
 * despacio las derivas. No resta la calibración propia: expo-sensors ya entrega el campo
 * compensado por el sistema (Sensor.TYPE_MAGNETIC_FIELD en Android, el campo calibrado de
 * CoreMotion en iOS), que además se recalibra solo; restar encima un offset fijo lo aplicaría
 * dos veces. Las muestras van a refs y la interfaz se refresca a ~20 fps.
 */
export function useMagneticField({
  isRunning,
  sensitivity,
  isVibrationEnabled,
}: {
  isRunning: boolean;
  sensitivity: DetectorSensitivity;
  isVibrationEnabled: boolean;
}) {
  const [deviationHistory] = useState(() => createRingBuffer(historyCapacity));
  const [timestampHistory] = useState(() => createRingBuffer(historyCapacity));
  const [chartValues] = useState(() => new Float64Array(historyCapacity));
  const latestVector = useRef<MagneticVector | null>(null);
  const latestDeviation = useRef<number | null>(null);
  const baselineMagnitude = useRef<number | null>(null);
  const previousTimestamp = useRef<number | null>(null);
  const isAlerting = useRef(false);
  const peakDeviation = useRef(0);
  // Al arrancar se pone a cero solo: la primera lectura estable es la referencia.
  const zeroingMagnitudes = useRef<number[] | null>([]);
  const zeroingStartTimestamp = useRef<number | null>(null);
  const alertDetector = useRef(createEventDetector(
    detectorThresholdsBySensitivity[sensitivity].trigger,
    detectorThresholdsBySensitivity[sensitivity].release,
  ));
  const shouldVibrate = useRef(isVibrationEnabled);
  const sensitivityRef = useRef(sensitivity);

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
    sensitivityRef.current = sensitivity;
    isAlerting.current = false;
  }, [sensitivity]);
  useEffect(() => {
    shouldVibrate.current = isVibrationEnabled;
  }, [isVibrationEnabled]);
  useSensorSubscription(
    magnetometerSource,
    ({ timestampSeconds, value }) => {
      latestVector.current = value;
      const elapsedSeconds = previousTimestamp.current === null ? 0 : timestampSeconds - previousTimestamp.current;
      previousTimestamp.current = timestampSeconds;

      if (zeroingMagnitudes.current) {
        zeroingStartTimestamp.current ??= timestampSeconds;
        zeroingMagnitudes.current.push(vectorMagnitude(value));
        if (timestampSeconds - zeroingStartTimestamp.current >= zeroingDurationSeconds) {
          const magnitudeSum = zeroingMagnitudes.current.reduce((runningSum, magnitude) => runningSum + magnitude, 0);
          baselineMagnitude.current = magnitudeSum / zeroingMagnitudes.current.length;
          zeroingMagnitudes.current = null;
          zeroingStartTimestamp.current = null;
          peakDeviation.current = 0;
          isAlerting.current = false;
          alertDetector.current.reset();
        }
        return;
      }
      if (baselineMagnitude.current === null) return;

      const deviation = deviationFromBaseline(value, baselineMagnitude.current);
      latestDeviation.current = deviation;
      peakDeviation.current = Math.max(peakDeviation.current, deviation);
      pushToRingBuffer(deviationHistory, deviation);
      pushToRingBuffer(timestampHistory, timestampSeconds);
      const { release } = detectorThresholdsBySensitivity[sensitivityRef.current];
      if (alertDetector.current.push(deviation)) {
        isAlerting.current = true;
        if (shouldVibrate.current) Vibration.vibrate(alertVibrationMilliseconds);
      } else if (deviation < release) {
        isAlerting.current = false;
      }
      baselineMagnitude.current = trackBaselineMagnitude(
        baselineMagnitude.current,
        vectorMagnitude(value),
        Math.min(elapsedSeconds, maximumTrackingStepSeconds),
        isAlerting.current ? baselineTrackingDuringAlertTimeConstantSeconds : baselineTrackingTimeConstantSeconds,
      );
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
        deviationMicroteslas: zeroingMagnitudes.current ? null : latestDeviation.current,
        peakDeviationMicroteslas: peakDeviation.current,
        baselineMagnitudeMicroteslas: baselineMagnitude.current,
        isZeroing: zeroingMagnitudes.current !== null,
        isAboveThreshold: !zeroingMagnitudes.current && (latestDeviation.current ?? 0) >= trigger,
        chartValues,
        chartSampleCount,
      }));
    }, displayRefreshIntervalMilliseconds);
    return () => clearInterval(displayTimer);
  }, [isRunning, sensitivity, deviationHistory, timestampHistory, chartValues]);

  /** Fija la línea base con la media del próximo segundo (hay que alejar el móvil del metal). */
  const zero = useCallback(() => {
    zeroingMagnitudes.current = [];
    zeroingStartTimestamp.current = null;
    latestDeviation.current = null;
  }, []);

  return { snapshot, zero };
}
