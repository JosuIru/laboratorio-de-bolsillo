import { useCallback, useEffect, useRef, useState } from 'react';

const tickMilliseconds = 250;

/**
 * Cuenta atrás desde que se moja la tira. Al llegar a cero llama a `onFinished` una sola vez.
 * Usa la hora de fin (no cuenta ticks) para no desviarse si el hilo JS va cargado.
 */
export function useReadingCountdown(onFinished: (countdownDurationSeconds: number) => void) {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [dipTime, setDipTime] = useState<number | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestOnFinished = useRef(onFinished);

  useEffect(() => {
    latestOnFinished.current = onFinished;
  }, [onFinished]);

  const stopTimer = useCallback(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
  }, []);

  const start = useCallback(
    (durationSeconds: number) => {
      stopTimer();
      const startTime = Date.now();
      const endTime = startTime + durationSeconds * 1000;
      setDipTime(startTime);
      setRemainingSeconds(durationSeconds);
      countdownTimer.current = setInterval(() => {
        const secondsLeft = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
        setRemainingSeconds(secondsLeft);
        if (secondsLeft === 0) {
          stopTimer();
          setRemainingSeconds(null);
          latestOnFinished.current(durationSeconds);
        }
      }, tickMilliseconds);
    },
    [stopTimer],
  );

  /** Cancela la cuenta atrás y olvida el momento en que se mojó la tira. */
  const reset = useCallback(() => {
    stopTimer();
    setRemainingSeconds(null);
    setDipTime(null);
  }, [stopTimer]);

  useEffect(() => stopTimer, [stopTimer]);

  return { remainingSeconds, isRunning: remainingSeconds !== null, dipTime, start, reset };
}
