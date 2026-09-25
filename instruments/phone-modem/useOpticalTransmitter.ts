import { useCallback, useEffect, useRef, useState } from 'react';

import { useIsAppActive } from '@/core/useIsAppActive';
import {
  type OpticalModemConfiguration,
  opticalLightLevelAt,
} from '@/processing/modem/opticalModem';

export type OpticalTransmissionState =
  | { status: 'idle' }
  | { status: 'sending'; progress: number; durationSeconds: number };

/** Oscuridad antes de empezar, para que el receptor vea bien el primer encendido. */
const leadInSeconds = 0.6;
const progressUpdateSeconds = 0.25;

/**
 * Hace parpadear la luz según los chips de una trama. El reloj es absoluto (no se acumulan
 * retrasos): en cada fotograma de pantalla se calcula qué chip toca y solo se avisa cuando la
 * luz cambia. `onLightLevelChange` recibe 1 (encender) o 0 (apagar); la pantalla lo pinta y la
 * linterna lo manda a la cámara. La luz se apaga al acabar, al cancelar o al salir de la app.
 */
export function useOpticalTransmitter(onLightLevelChange: (lightLevel: number) => void) {
  const isAppActive = useIsAppActive();
  const [transmissionState, setTransmissionState] = useState<OpticalTransmissionState>({ status: 'idle' });
  const [lightLevel, setLightLevel] = useState(0);
  const animationFrameRef = useRef<number | null>(null);
  const onLightLevelChangeRef = useRef(onLightLevelChange);
  useEffect(() => {
    onLightLevelChangeRef.current = onLightLevelChange;
  }, [onLightLevelChange]);

  const stopTransmission = useCallback(() => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    setLightLevel(0);
    onLightLevelChangeRef.current(0);
    setTransmissionState({ status: 'idle' });
  }, []);

  useEffect(() => {
    if (!isAppActive && animationFrameRef.current !== null) stopTransmission();
  }, [isAppActive, stopTransmission]);
  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        onLightLevelChangeRef.current(0);
      }
    },
    [],
  );

  const transmitChips = useCallback(
    (chips: readonly number[], configuration: OpticalModemConfiguration) => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      const durationSeconds = leadInSeconds + chips.length * configuration.chipDurationSeconds;
      const startMilliseconds = performance.now();
      let currentLightLevel = 0;
      let lastProgressSeconds = -Infinity;
      setLightLevel(0);
      onLightLevelChangeRef.current(0);
      setTransmissionState({ status: 'sending', progress: 0, durationSeconds });

      const handleAnimationFrame = () => {
        const elapsedSeconds = (performance.now() - startMilliseconds) / 1000;
        if (elapsedSeconds >= durationSeconds + configuration.chipDurationSeconds) {
          animationFrameRef.current = null;
          stopTransmission();
          return;
        }
        const nextLightLevel = opticalLightLevelAt(chips, elapsedSeconds - leadInSeconds, configuration);
        if (nextLightLevel !== currentLightLevel) {
          currentLightLevel = nextLightLevel;
          setLightLevel(nextLightLevel);
          onLightLevelChangeRef.current(nextLightLevel);
        }
        if (elapsedSeconds - lastProgressSeconds >= progressUpdateSeconds) {
          lastProgressSeconds = elapsedSeconds;
          setTransmissionState({
            status: 'sending',
            progress: Math.min(1, elapsedSeconds / durationSeconds),
            durationSeconds,
          });
        }
        animationFrameRef.current = requestAnimationFrame(handleAnimationFrame);
      };
      animationFrameRef.current = requestAnimationFrame(handleAnimationFrame);
    },
    [stopTransmission],
  );

  return { transmissionState, lightLevel, transmitChips, cancelTransmission: stopTransmission };
}
