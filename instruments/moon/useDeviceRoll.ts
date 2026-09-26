import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import type { Vector3 } from '@/core/sensors/types';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { smoothVector, type DeviceVector } from '@/processing/astronomy/pointingGuide';

import { deviceRollFromUpwardAcceleration } from './moonAtlas';

const sensorRateHz = 10;
const sensorSmoothingFactor = 0.2;

/**
 * Giro del móvil alrededor del eje de la cámara (para orientar el atlas): se lee el último valor
 * con `readDeviceRollDegrees()` en el momento de la captura. null si no hay lecturas o si la
 * cámara mira casi al cenit.
 */
export function useDeviceRoll(isActive: boolean) {
  const smoothedAcceleration = useRef<DeviceVector | null>(null);

  useSensorSubscription(
    accelerometerSource,
    (sample: { value: Vector3 }) => {
      // Android da la reacción a la gravedad (hacia arriba); iOS, la gravedad (hacia abajo).
      const upwardSign = Platform.OS === 'ios' ? -1 : 1;
      smoothedAcceleration.current = smoothVector(
        smoothedAcceleration.current,
        { x: upwardSign * sample.value.x, y: upwardSign * sample.value.y, z: upwardSign * sample.value.z },
        sensorSmoothingFactor,
      );
    },
    { isActive, targetRateHz: sensorRateHz },
  );

  return useCallback(
    () => (smoothedAcceleration.current ? deviceRollFromUpwardAcceleration(smoothedAcceleration.current) : null),
    [],
  );
}
