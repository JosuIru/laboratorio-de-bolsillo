import { useCallback, useEffect, useRef, useState } from 'react';

/** Refresco de la cuenta atrás en pantalla. */
const countdownTickMilliseconds = 200;

/**
 * Cuenta atrás que solo avanza mientras `isRunning` es `true` (se congela en pausa o con la app
 * en segundo plano). Llama a `onExpire` una vez al llegar a cero.
 */
export function useHuntCountdown(durationSeconds: number, isRunning: boolean, onExpire: () => void) {
  const fullDurationMilliseconds = durationSeconds * 1000;
  const remainingMillisecondsRef = useRef(fullDurationMilliseconds);
  const [remainingMilliseconds, setRemainingMilliseconds] = useState(fullDurationMilliseconds);
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (!isRunning || remainingMillisecondsRef.current <= 0) return;
    let lastTickTime = Date.now();
    const consumeElapsedTime = () => {
      const currentTime = Date.now();
      remainingMillisecondsRef.current = Math.max(0, remainingMillisecondsRef.current - (currentTime - lastTickTime));
      lastTickTime = currentTime;
    };
    const countdownTimer = setInterval(() => {
      consumeElapsedTime();
      setRemainingMilliseconds(remainingMillisecondsRef.current);
      if (remainingMillisecondsRef.current <= 0) {
        clearInterval(countdownTimer);
        onExpireRef.current();
      }
    }, countdownTickMilliseconds);
    return () => {
      clearInterval(countdownTimer);
      consumeElapsedTime();
    };
  }, [isRunning]);

  /** Vuelve a poner el reloj entero (al empezar un turno). */
  const resetCountdown = useCallback(() => {
    remainingMillisecondsRef.current = fullDurationMilliseconds;
    setRemainingMilliseconds(fullDurationMilliseconds);
  }, [fullDurationMilliseconds]);

  /** Segundos restantes exactos en este instante (para puntuar la captura). */
  const readRemainingSeconds = useCallback(() => remainingMillisecondsRef.current / 1000, []);

  return { remainingSeconds: remainingMilliseconds / 1000, resetCountdown, readRemainingSeconds };
}
