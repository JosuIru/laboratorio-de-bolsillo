import { useCallback, useRef, useState } from 'react';

import { gyroscopeSource } from '@/core/sensors/adapters/motionAndEnvironment';
import type { Vector3 } from '@/core/sensors/types';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';

const gyroscopeRateHz = 50;
/**
 * Giro máximo para considerar el móvil quieto, en rad/s (~0,9 °/s). Con zoom, un temblor de
 * pocos grados por segundo ya corre la Luna varios píxeles durante la exposición de un fotograma.
 */
const steadyAngularSpeedRadiansPerSecond = 0.016;
/** Suavizado de la velocidad angular: evita que un pico aislado cuente como movimiento. */
const angularSpeedSmoothingFactor = 0.3;
/** Actualizaciones por segundo del indicador en pantalla. */
const maximumIndicatorUpdatesPerSecond = 5;

/**
 * Indica si el móvil está quieto, con el giroscopio. `isDeviceSteady` se puede consultar en
 * cualquier momento (sin esperar a un render); `isSteadyForDisplay` es para el indicador.
 * Sin giroscopio, se considera siempre quieto.
 */
export function useDeviceSteadiness(isActive: boolean, hasGyroscope: boolean) {
  const smoothedAngularSpeed = useRef(0);
  const lastIndicatorUpdateTime = useRef(0);
  const [isSteadyForDisplay, setIsSteadyForDisplay] = useState(true);

  useSensorSubscription(
    gyroscopeSource,
    (sample: { value: Vector3 }) => {
      const angularSpeed = Math.hypot(sample.value.x, sample.value.y, sample.value.z);
      smoothedAngularSpeed.current += angularSpeedSmoothingFactor * (angularSpeed - smoothedAngularSpeed.current);
      const currentTime = Date.now();
      if (currentTime - lastIndicatorUpdateTime.current < 1000 / maximumIndicatorUpdatesPerSecond) return;
      lastIndicatorUpdateTime.current = currentTime;
      setIsSteadyForDisplay(smoothedAngularSpeed.current < steadyAngularSpeedRadiansPerSecond);
    },
    { isActive: isActive && hasGyroscope, targetRateHz: gyroscopeRateHz },
  );

  const isDeviceSteady = useCallback(
    () => !hasGyroscope || smoothedAngularSpeed.current < steadyAngularSpeedRadiansPerSecond,
    [hasGyroscope],
  );

  return { isDeviceSteady, isSteadyForDisplay: !hasGyroscope || isSteadyForDisplay };
}
