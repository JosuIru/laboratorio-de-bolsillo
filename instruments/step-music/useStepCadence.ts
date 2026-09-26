import { useEffect, useRef, useState } from 'react';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';

import { type CadenceEstimate, estimateCadence } from './stepCadence';

/** Ventana analizada: 8 s, suficiente para ver varios pasos incluso andando despacio. */
const analysisWindowSeconds = 8;
const analysisIntervalMilliseconds = 1000;
/** Mediana de las últimas estimaciones: una zancada rara no cambia el tempo de golpe. */
const smoothingCount = 3;

/** Cadencia de pasos en directo a partir del acelerómetro. */
export function useStepCadence(isActive: boolean) {
  const samplesRef = useRef<{ timestampsSeconds: number[]; magnitudes: number[] }>({
    timestampsSeconds: [],
    magnitudes: [],
  });
  const recentEstimatesRef = useRef<number[]>([]);
  const [cadenceEstimate, setCadenceEstimate] = useState<CadenceEstimate | null>(null);

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      const recordedSamples = samplesRef.current;
      recordedSamples.timestampsSeconds.push(timestampSeconds);
      recordedSamples.magnitudes.push(Math.hypot(value.x, value.y, value.z));
      // Se descarta lo que ya no cabe en la ventana.
      const oldestKeptSeconds = timestampSeconds - analysisWindowSeconds;
      let firstKeptIndex = 0;
      while (recordedSamples.timestampsSeconds[firstKeptIndex]! < oldestKeptSeconds) firstKeptIndex++;
      if (firstKeptIndex > 0) {
        recordedSamples.timestampsSeconds.splice(0, firstKeptIndex);
        recordedSamples.magnitudes.splice(0, firstKeptIndex);
      }
    },
    { isActive, targetRateHz: 50 },
  );

  useEffect(() => {
    if (!isActive) return;
    samplesRef.current = { timestampsSeconds: [], magnitudes: [] };
    recentEstimatesRef.current = [];
    const analysisTimer = setInterval(() => {
      const { timestampsSeconds, magnitudes } = samplesRef.current;
      const latestEstimate = estimateCadence(timestampsSeconds, magnitudes);
      if (!latestEstimate) {
        recentEstimatesRef.current = [];
        setCadenceEstimate(null);
        return;
      }
      const recentEstimates = [...recentEstimatesRef.current, latestEstimate.stepsPerMinute].slice(-smoothingCount);
      recentEstimatesRef.current = recentEstimates;
      const sortedEstimates = [...recentEstimates].sort((leftValue, rightValue) => leftValue - rightValue);
      setCadenceEstimate({
        stepsPerMinute: sortedEstimates[Math.floor(sortedEstimates.length / 2)]!,
        clarity: latestEstimate.clarity,
      });
    }, analysisIntervalMilliseconds);
    return () => clearInterval(analysisTimer);
  }, [isActive]);

  return isActive ? cadenceEstimate : null;
}
