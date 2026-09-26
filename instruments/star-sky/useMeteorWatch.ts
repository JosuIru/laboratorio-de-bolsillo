import { useCallback, useRef, useState } from 'react';

import { type MeteorEvent, type MeteorWatchStatistics, MeteorWatcher } from '@/processing/image/meteorDetection';

import { type SkyFrame, useSkyFrames } from './useSkyFrames';

/** Eventos que se guardan con su fotograma (los demás solo se cuentan). */
const maximumStoredEvents = 30;
/** Cada cuánto se refrescan las cifras en pantalla. */
const statisticsRefreshMilliseconds = 1000;

export interface WatchedMeteorEvent extends MeteorEvent {
  /** Hora del reloj del fotograma del evento. */
  detectedAt: Date;
}

export interface MeteorWatchSession {
  startedAt: Date;
  endedAt: Date | null;
  statistics: MeteorWatchStatistics;
  events: WatchedMeteorEvent[];
  /** Tamaño de los fotogramas analizados (reducidos). */
  frameWidth: number;
  frameHeight: number;
}

const emptyStatistics: MeteorWatchStatistics = {
  processedFrameCount: 0,
  skippedFrameCount: 0,
  meteorCount: 0,
  rejectedSlowMoverCount: 0,
  watchedMilliseconds: 0,
};

/**
 * Vigilancia de meteoros sobre el flujo de vídeo: pasa `frameOutput` a la cámara. Los fotogramas
 * van al `MeteorWatcher` en el hilo JS; los meteoros confirmados se guardan con su fotograma.
 */
export function useMeteorWatch() {
  const [isWatching, setIsWatching] = useState(false);
  const [session, setSession] = useState<MeteorWatchSession | null>(null);
  const watcherRef = useRef<MeteorWatcher | null>(null);
  const eventsRef = useRef<WatchedMeteorEvent[]>([]);
  const lastRefreshTime = useRef(0);

  const refreshSession = useCallback((isFinal: boolean) => {
    const watcher = watcherRef.current;
    if (!watcher) return;
    const statistics = watcher.statistics();
    setSession((previousSession) =>
      previousSession
        ? {
            ...previousSession,
            endedAt: isFinal ? new Date() : null,
            statistics,
            events: eventsRef.current.slice(),
            frameWidth: watcher.width,
            frameHeight: watcher.height,
          }
        : previousSession,
    );
  }, []);

  const collectEvents = useCallback((confirmedMeteors: MeteorEvent[]) => {
    for (const confirmedMeteor of confirmedMeteors) {
      if (eventsRef.current.length >= maximumStoredEvents) break;
      eventsRef.current.push({ ...confirmedMeteor, detectedAt: new Date(confirmedMeteor.timestampMilliseconds) });
    }
  }, []);

  const handleSkyFrame = useCallback(
    (skyFrame: SkyFrame) => {
      let watcher = watcherRef.current;
      if (!watcher || watcher.width !== skyFrame.width || watcher.height !== skyFrame.height) {
        // Primer fotograma (o la cámara ha cambiado de tamaño): se empieza de nuevo.
        watcher = new MeteorWatcher(skyFrame.width, skyFrame.height);
        watcherRef.current = watcher;
      }
      const { confirmedMeteors } = watcher.addFrame(skyFrame.grayBytes, skyFrame.wallClockMilliseconds);
      collectEvents(confirmedMeteors);
      if (confirmedMeteors.length > 0 || skyFrame.wallClockMilliseconds - lastRefreshTime.current > statisticsRefreshMilliseconds) {
        lastRefreshTime.current = skyFrame.wallClockMilliseconds;
        refreshSession(false);
      }
    },
    [collectEvents, refreshSession],
  );

  const frameOutput = useSkyFrames(isWatching, handleSkyFrame);

  const startWatching = useCallback(() => {
    watcherRef.current = null;
    eventsRef.current = [];
    setSession({ startedAt: new Date(), endedAt: null, statistics: emptyStatistics, events: [], frameWidth: 0, frameHeight: 0 });
    setIsWatching(true);
  }, []);

  const stopWatching = useCallback(() => {
    setIsWatching(false);
    const watcher = watcherRef.current;
    if (watcher) collectEvents(watcher.flush());
    refreshSession(true);
  }, [collectEvents, refreshSession]);

  const clearSession = useCallback(() => {
    watcherRef.current = null;
    eventsRef.current = [];
    setSession(null);
  }, []);

  return { frameOutput, isWatching, session, startWatching, stopWatching, clearSession };
}
