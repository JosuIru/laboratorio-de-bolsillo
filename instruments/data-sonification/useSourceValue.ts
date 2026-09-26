import { useEffect, useRef, useState } from 'react';

import {
  accelerometerSource,
  gyroscopeSource,
  lightSource,
  magnetometerSource,
} from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';

import {
  createValueSmoother,
  normalizeSourceValue,
  type SonificationSourceId,
  tiltDegreesFromGravity,
} from './sonification';

const displayIntervalMilliseconds = 100;
/** Suavizado del valor que suena: rápido para que responda, pero sin el temblor del sensor. */
const valueTimeConstantSeconds = 0.12;
/** Estimación lenta de la gravedad para quitarla y quedarse con la vibración. */
const gravityTimeConstantSeconds = 0.5;
/** Tiempo con el que se fija el campo magnético de referencia al empezar. */
const magneticBaselineSeconds = 1;

export interface SourceReading {
  sourceValue: number;
  normalizedValue: number;
}

/**
 * Lee la fuente elegida y la convierte en un valor en su unidad y en [0, 1]. Devuelve también una
 * referencia con el último valor normalizado, para que el sonido lo lea sin esperar al render.
 */
export function useSourceValue(sourceId: SonificationSourceId, isActive: boolean) {
  const [sourceReading, setSourceReading] = useState<SourceReading | null>(null);
  const latestReadingRef = useRef<SourceReading | null>(null);
  const [valueSmoother] = useState(() => createValueSmoother(valueTimeConstantSeconds));
  const gravityEstimateRef = useRef<{ x: number; y: number; z: number; timestampSeconds: number } | null>(null);
  const magneticBaselineRef = useRef<{
    sum: { x: number; y: number; z: number };
    count: number;
    startSeconds: number;
  } | null>(null);

  // Al cambiar de fuente o parar, se empieza de cero (otra unidad, otra referencia).
  useEffect(() => {
    valueSmoother.reset();
    gravityEstimateRef.current = null;
    magneticBaselineRef.current = null;
    latestReadingRef.current = null;
  }, [sourceId, isActive, valueSmoother]);

  function publish(rawValue: number, timestampSeconds: number) {
    const sourceValue = valueSmoother.push(rawValue, timestampSeconds);
    latestReadingRef.current = { sourceValue, normalizedValue: normalizeSourceValue(sourceId, sourceValue) };
  }

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      if (sourceId === 'tilt') {
        publish(tiltDegreesFromGravity(value.x, value.y, value.z), timestampSeconds);
        return;
      }
      const gravityEstimate = gravityEstimateRef.current;
      if (!gravityEstimate) {
        gravityEstimateRef.current = { ...value, timestampSeconds };
        return;
      }
      const blendFactor =
        1 - Math.exp(-Math.max(0, timestampSeconds - gravityEstimate.timestampSeconds) / gravityTimeConstantSeconds);
      gravityEstimate.x += blendFactor * (value.x - gravityEstimate.x);
      gravityEstimate.y += blendFactor * (value.y - gravityEstimate.y);
      gravityEstimate.z += blendFactor * (value.z - gravityEstimate.z);
      gravityEstimate.timestampSeconds = timestampSeconds;
      publish(
        Math.hypot(value.x - gravityEstimate.x, value.y - gravityEstimate.y, value.z - gravityEstimate.z),
        timestampSeconds,
      );
    },
    { isActive: isActive && (sourceId === 'tilt' || sourceId === 'vibration'), targetRateHz: 100 },
  );

  useSensorSubscription(
    gyroscopeSource,
    ({ timestampSeconds, value }) => publish(Math.hypot(value.x, value.y, value.z), timestampSeconds),
    { isActive: isActive && sourceId === 'rotation', targetRateHz: 50 },
  );

  useSensorSubscription(
    magnetometerSource,
    ({ timestampSeconds, value }) => {
      const magneticBaseline = magneticBaselineRef.current;
      if (!magneticBaseline) {
        magneticBaselineRef.current = { sum: { ...value }, count: 1, startSeconds: timestampSeconds };
        return;
      }
      if (timestampSeconds - magneticBaseline.startSeconds < magneticBaselineSeconds) {
        magneticBaseline.sum.x += value.x;
        magneticBaseline.sum.y += value.y;
        magneticBaseline.sum.z += value.z;
        magneticBaseline.count++;
        return;
      }
      const { sum, count } = magneticBaseline;
      publish(Math.hypot(value.x - sum.x / count, value.y - sum.y / count, value.z - sum.z / count), timestampSeconds);
    },
    { isActive: isActive && sourceId === 'magnetic', targetRateHz: 20 },
  );

  useSensorSubscription(lightSource, ({ timestampSeconds, value }) => publish(value, timestampSeconds), {
    isActive: isActive && sourceId === 'light',
  });

  useEffect(() => {
    if (!isActive) return;
    const displayTimer = setInterval(() => setSourceReading(latestReadingRef.current), displayIntervalMilliseconds);
    return () => clearInterval(displayTimer);
  }, [isActive]);

  return { sourceReading: isActive ? sourceReading : null, latestReadingRef };
}
