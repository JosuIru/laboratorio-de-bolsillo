import { useRef, useState } from 'react';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { type TiltAngles, tiltAnglesFromGravity } from '@/processing/signal/orientation';
import { createExponentialSmoother, smoothingFactorForTimeConstant } from '@/processing/signal/smoothing';

const sampleRateHz = 30;
const smoothingTimeConstantSeconds = 0.25;

/** Inclinación suavizada a partir del acelerómetro (sin calibrar). */
export function useTiltAngles(): TiltAngles | null {
  const [tiltAngles, setTiltAngles] = useState<TiltAngles | null>(null);
  const smoothers = useRef({
    tiltX: createExponentialSmoother(smoothingFactorForTimeConstant(smoothingTimeConstantSeconds, sampleRateHz)),
    tiltY: createExponentialSmoother(smoothingFactorForTimeConstant(smoothingTimeConstantSeconds, sampleRateHz)),
  });

  useSensorSubscription(
    accelerometerSource,
    (sample) => {
      const rawTilt = tiltAnglesFromGravity(sample.value);
      setTiltAngles({
        tiltXDegrees: smoothers.current.tiltX.push(rawTilt.tiltXDegrees),
        tiltYDegrees: smoothers.current.tiltY.push(rawTilt.tiltYDegrees),
      });
    },
    { targetRateHz: sampleRateHz },
  );

  return tiltAngles;
}
