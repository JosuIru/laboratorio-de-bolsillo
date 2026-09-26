import { useEffect, useEffectEvent } from 'react';

import { useIsScreenActive } from '../useIsScreenActive';

import type { SensorSource, SubscribeOptions, TimedSample } from './types';

/**
 * Se suscribe a un sensor mientras el componente está montado, `isActive` es verdadero y la
 * pantalla está visible (no tapada por Historial o Calibrar ni con la app en segundo plano).
 * El callback puede cambiar entre renders sin reiniciar la suscripción.
 */
export function useSensorSubscription<TValue>(
  sensorSource: SensorSource<TValue>,
  onSample: (sample: TimedSample<TValue>) => void,
  options: SubscribeOptions & { isActive?: boolean } = {},
): void {
  const handleSample = useEffectEvent(onSample);
  const { isActive = true, targetRateHz } = options;
  const isScreenActive = useIsScreenActive();
  const shouldSubscribe = isActive && isScreenActive;

  useEffect(() => {
    if (!shouldSubscribe) return;
    return sensorSource.subscribe((sample) => handleSample(sample), { targetRateHz });
  }, [sensorSource, shouldSubscribe, targetRateHz]);
}
