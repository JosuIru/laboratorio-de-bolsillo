import { useCallback, useRef, useState } from 'react';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';

import {
  advanceCycleDetector,
  assumeAlreadyRunning,
  createCycleDetectorState,
  type CycleDetectorSettings,
  type CycleDetectorState,
} from './cycleDetector';
import { createWindowLevelMeter } from './vibrationLevel';

/**
 * 50 Hz sobran para saber si una máquina vibra (no buscamos su frecuencia) y gastan mucha menos
 * batería que los 200-500 Hz del sismógrafo.
 */
const requestedRateHz = 50;
/** Máximo de ventanas (de ~1 s) que se guardan para la gráfica: 6 h, más que cualquier ciclo. */
const maximumHistoryLength = 6 * 3600;

/**
 * Vigila la vibración: calcula el nivel en ventanas de ~1 s y se lo pasa al detector de ciclo.
 * La interfaz se repinta una vez por ventana, no con cada muestra. Al terminar el ciclo deja de
 * leer el acelerómetro. Si la app pasa a segundo plano (o la tapa otra pantalla), los sensores
 * se paran: se deja de vigilar y se avisa con `wasInterrupted`.
 */
export function useCycleWatcher(detectorSettings: CycleDetectorSettings) {
  const [isWatching, setIsWatching] = useState(false);
  const [wasInterrupted, setWasInterrupted] = useState(false);
  const [detectorState, setDetectorState] = useState<CycleDetectorState>(createCycleDetectorState);
  const detectorStateRef = useRef(detectorState);
  const [levelMeter] = useState(() => createWindowLevelMeter());
  /** Niveles de toda la sesión (uno por ventana); `historyRevision` avisa a la gráfica. */
  const [levelHistory] = useState<number[]>(() => []);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [latestLevel, setLatestLevel] = useState<number | null>(null);

  const replaceDetectorState = useCallback((nextState: CycleDetectorState) => {
    detectorStateRef.current = nextState;
    setDetectorState(nextState);
  }, []);

  const isReadingSensor = isWatching && detectorState.phase !== 'finished';

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      const sensorWindow = levelMeter.push(timestampSeconds, value.x, value.y, value.z);
      if (!sensorWindow) return;
      // El detector trabaja con el reloj de pared: así las horas de inicio y fin salen directas.
      const endSeconds = Date.now() / 1000;
      const startSeconds = endSeconds - (sensorWindow.endTimestampSeconds - sensorWindow.startTimestampSeconds);
      levelHistory.push(sensorWindow.level);
      if (levelHistory.length > maximumHistoryLength) levelHistory.shift();
      replaceDetectorState(
        advanceCycleDetector(
          detectorStateRef.current,
          { startSeconds, endSeconds, level: sensorWindow.level, sampleCount: sensorWindow.sampleCount },
          detectorSettings,
        ),
      );
      setLatestLevel(sensorWindow.level);
      setHistoryRevision((previousRevision) => previousRevision + 1);
    },
    { isActive: isReadingSensor, targetRateHz: requestedRateHz },
  );

  const releaseLevelMeter = useCallback(() => levelMeter.reset(), [levelMeter]);
  useStopWhenAppInactive(() => {
    if (!isWatching) return;
    setIsWatching(false);
    if (detectorState.phase !== 'finished') setWasInterrupted(true);
  }, releaseLevelMeter);

  const startWatching = useCallback(() => {
    levelMeter.reset();
    levelHistory.splice(0);
    replaceDetectorState(createCycleDetectorState());
    setLatestLevel(null);
    setWasInterrupted(false);
    setHistoryRevision((previousRevision) => previousRevision + 1);
    setIsWatching(true);
  }, [levelMeter, levelHistory, replaceDetectorState]);

  const stopWatching = useCallback(() => {
    levelMeter.reset();
    setIsWatching(false);
  }, [levelMeter]);

  const markAlreadyRunning = useCallback(
    (fallbackThreshold: number) => {
      replaceDetectorState(assumeAlreadyRunning(detectorStateRef.current, Date.now() / 1000, fallbackThreshold));
    },
    [replaceDetectorState],
  );

  return {
    isWatching,
    wasInterrupted,
    detectorState,
    latestLevel,
    levelHistory,
    historyRevision,
    startWatching,
    stopWatching,
    markAlreadyRunning,
  };
}
