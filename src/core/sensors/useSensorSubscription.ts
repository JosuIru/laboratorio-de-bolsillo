import { useEffect, useEffectEvent } from 'react';

import type { SensorSource, SubscribeOptions, TimedSample } from './types';

/**
 * Se suscribe a un sensor mientras el componente está montado y `isActive` es verdadero.
 * El callback puede cambiar entre renders sin reiniciar la suscripción.
 */
export function useSensorSubscription<TValue>(
  sensorSource: SensorSource<TValue>,
  onSample: (sample: TimedSample<TValue>) => void,
  options: SubscribeOptions & { isActive?: boolean } = {},
): void {
  const handleSample = useEffectEvent(onSample);
  const { isActive = true, targetRateHz } = options;

  useEffect(() => {
    if (!isActive) return;
    return sensorSource.subscribe((sample) => handleSample(sample), { targetRateHz });
  }, [sensorSource, isActive, targetRateHz]);
}
