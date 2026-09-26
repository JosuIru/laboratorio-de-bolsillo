import { useRef, useState } from 'react';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { tiltAnglesFromGravity } from '@/processing/signal/orientation';

import { type AveragedTilt, createTiltAverager } from './tiltAverager';

const sampleRateHz = 30;
/** Ventana de la media: larga para que un calzo mal puesto o un paso dentro no hagan bailar los cm. */
const averagingWindowSeconds = 1.5;
/** La pantalla se refresca a 10 Hz: más no se aprecia y ahorra batería. */
const samplesPerScreenUpdate = 3;

/** Inclinación del móvil (sin cero aplicado) promediada sobre la última ventana. */
export function useAveragedTilt(): AveragedTilt | null {
  const [averagedTilt, setAveragedTilt] = useState<AveragedTilt | null>(null);
  const tiltAverager = useRef(createTiltAverager(Math.round(averagingWindowSeconds * sampleRateHz)));
  const samplesSinceScreenUpdate = useRef(0);

  useSensorSubscription(
    accelerometerSource,
    (sample) => {
      const latestAveragedTilt = tiltAverager.current.push(tiltAnglesFromGravity(sample.value));
      samplesSinceScreenUpdate.current += 1;
      if (samplesSinceScreenUpdate.current >= samplesPerScreenUpdate) {
        samplesSinceScreenUpdate.current = 0;
        setAveragedTilt(latestAveragedTilt);
      }
    },
    { targetRateHz: sampleRateHz },
  );

  return averagedTilt;
}
