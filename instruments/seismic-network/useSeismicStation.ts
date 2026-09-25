import { useCallback, useEffect, useRef, useState } from 'react';

import { useIsAppActive } from '@/core/useIsAppActive';
import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { createOnsetDetector, type OnsetDetector, type OnsetDetectorPhase } from '@/processing/seismology/staLta';
import { estimateSampleRateHz } from '@/processing/signal/resampling';
import { copyLatestFromRingBuffer, createRingBuffer, pushToRingBuffer, type RingBuffer } from '@/processing/signal/ringBuffer';

import { type ArrivalWaveform, extractArrivalWaveform } from './arrivalWaveform';

/** Pedimos la máxima frecuencia; el sistema entrega lo que el sensor permite. */
const requestedRateHz = 500;
/** Unos 8 s de señal cruda a 500 Hz: de sobra para recortar la ventana de cada golpe. */
const rawHistoryCapacity = 4096;
const displayRefreshIntervalMilliseconds = 100;
const maximumStoredArrivals = 6;
/** Ventana de forma de onda que se guarda con cada llegada: 1 s antes y 2 s después. */
const waveformSecondsBeforeArrival = 1;
const waveformSecondsAfterArrival = 2;

/**
 * - `waiting-sync`: todos los móviles juntos, esperando el golpe de sincronización.
 * - `synced`: ya hay referencia; el móvil se lleva a su sitio (los golpes se ignoran).
 * - `armed`: en su sitio y quieto; cada golpe se apunta como llegada.
 */
export type StationStage = 'idle' | 'waiting-sync' | 'synced' | 'armed';

export interface RecordedArrival {
  arrivalId: number;
  /** Segundos desde el golpe de sincronización (reloj del sensor de este móvil). */
  arrivalSeconds: number;
  peakRatio: number;
  peakAmplitude: number;
  /**
   * Forma de onda alrededor del golpe. Es `null` durante los 2 s que se esperan tras la llegada
   * para tener la onda completa.
   */
  waveform: ArrivalWaveform | null;
}

interface PendingWaveformCapture {
  arrivalId: number;
  onsetTimestampSeconds: number;
  syncTimestampSeconds: number;
}

interface RawHistory {
  timestamps: RingBuffer;
  accelerationX: RingBuffer;
  accelerationY: RingBuffer;
  accelerationZ: RingBuffer;
}

function createRawHistory(): RawHistory {
  return {
    timestamps: createRingBuffer(rawHistoryCapacity),
    accelerationX: createRingBuffer(rawHistoryCapacity),
    accelerationY: createRingBuffer(rawHistoryCapacity),
    accelerationZ: createRingBuffer(rawHistoryCapacity),
  };
}

function readRingBuffer(ringBuffer: RingBuffer): Float64Array {
  const latestValues = new Float64Array(ringBuffer.storedCount);
  copyLatestFromRingBuffer(ringBuffer, latestValues);
  return latestValues;
}

/**
 * Estación de la red: escucha el acelerómetro, detecta llegadas con STA/LTA + AIC y las
 * expresa respecto al golpe de sincronización.
 *
 * La sincronización funciona porque la marca de tiempo del sensor en Android es el reloj
 * monótono desde el arranque (no la hora del sistema, que cada móvil tiene distinta): la
 * diferencia «llegada − sincronización» solo depende del cristal del propio móvil, y el
 * retraso interno del sensor se cancela porque ambos golpes pasan por el mismo camino.
 */
export function useSeismicStation({ isEnabled, triggerRatio }: { isEnabled: boolean; triggerRatio: number }) {
  const isAppActive = useIsAppActive();
  const [initialOnsetDetector] = useState(() => createOnsetDetector({ triggerRatio }));
  const onsetDetector = useRef<OnsetDetector>(initialOnsetDetector);
  const [rawHistory] = useState(createRawHistory);
  const [stage, setStage] = useState<StationStage>('idle');
  const stageRef = useRef<StationStage>('idle');
  const syncTimestampSeconds = useRef<number | null>(null);
  const [recordedArrivals, setRecordedArrivals] = useState<RecordedArrival[]>([]);
  const nextArrivalId = useRef(1);
  /** Llegadas que esperan los 2 s posteriores para copiar su forma de onda, en orden de llegada. */
  const pendingWaveformCaptures = useRef<PendingWaveformCapture[]>([]);
  const [liveStatus, setLiveStatus] = useState<{ ratio: number; phase: OnsetDetectorPhase; sampleRateHz: number | null }>({
    ratio: 0,
    phase: 'warming-up',
    sampleRateHz: null,
  });

  useEffect(() => {
    onsetDetector.current = createOnsetDetector({ triggerRatio });
  }, [triggerRatio]);

  const changeStage = useCallback((nextStage: StationStage) => {
    stageRef.current = nextStage;
    setStage(nextStage);
  }, []);

  /**
   * Copia la ventana del golpe del historial y la guarda con su llegada. Se copia en el momento
   * (y no al pulsar «Guardar») porque el historial solo cubre unos segundos.
   */
  const completeWaveformCapture = useCallback(
    (pendingCapture: PendingWaveformCapture) => {
      const waveform = extractArrivalWaveform(
        {
          timestamps: readRingBuffer(rawHistory.timestamps),
          accelerationX: readRingBuffer(rawHistory.accelerationX),
          accelerationY: readRingBuffer(rawHistory.accelerationY),
          accelerationZ: readRingBuffer(rawHistory.accelerationZ),
        },
        pendingCapture.onsetTimestampSeconds - waveformSecondsBeforeArrival,
        pendingCapture.onsetTimestampSeconds + waveformSecondsAfterArrival,
        pendingCapture.syncTimestampSeconds,
      );
      setRecordedArrivals((previousArrivals) =>
        previousArrivals.map((recordedArrival) =>
          recordedArrival.arrivalId === pendingCapture.arrivalId ? { ...recordedArrival, waveform } : recordedArrival,
        ),
      );
    },
    [rawHistory],
  );

  const isSubscriptionActive = isEnabled && isAppActive && stage !== 'idle';

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      pushToRingBuffer(rawHistory.timestamps, timestampSeconds);
      pushToRingBuffer(rawHistory.accelerationX, value.x);
      pushToRingBuffer(rawHistory.accelerationY, value.y);
      pushToRingBuffer(rawHistory.accelerationZ, value.z);

      // Las capturas se completan cuando ya han pasado los 2 s posteriores a la llegada.
      while (
        pendingWaveformCaptures.current.length > 0 &&
        timestampSeconds >= pendingWaveformCaptures.current[0]!.onsetTimestampSeconds + waveformSecondsAfterArrival
      ) {
        completeWaveformCapture(pendingWaveformCaptures.current.shift()!);
      }

      const pick = onsetDetector.current.push(timestampSeconds, value.x, value.y, value.z);
      if (!pick) return;
      if (stageRef.current === 'waiting-sync') {
        syncTimestampSeconds.current = pick.onsetTimestampSeconds;
        changeStage('synced');
      } else if (stageRef.current === 'armed' && syncTimestampSeconds.current !== null) {
        const arrivalId = nextArrivalId.current++;
        const recordedArrival: RecordedArrival = {
          arrivalId,
          arrivalSeconds: pick.onsetTimestampSeconds - syncTimestampSeconds.current,
          peakRatio: pick.peakRatio,
          peakAmplitude: pick.peakAmplitude,
          waveform: null,
        };
        pendingWaveformCaptures.current.push({
          arrivalId,
          onsetTimestampSeconds: pick.onsetTimestampSeconds,
          syncTimestampSeconds: syncTimestampSeconds.current,
        });
        setRecordedArrivals((previousArrivals) => [recordedArrival, ...previousArrivals].slice(0, maximumStoredArrivals));
      }
    },
    { isActive: isSubscriptionActive, targetRateHz: requestedRateHz },
  );

  // Si el sensor se para (app en segundo plano) antes de completar una captura, se guarda lo
  // que haya: mejor una ventana corta que ninguna.
  useEffect(() => {
    if (isSubscriptionActive) return;
    for (const pendingCapture of pendingWaveformCaptures.current) completeWaveformCapture(pendingCapture);
    pendingWaveformCaptures.current = [];
  }, [isSubscriptionActive, completeWaveformCapture]);

  useEffect(() => {
    if (!isEnabled || stage === 'idle') return;
    const displayTimer = setInterval(() => {
      const recentTimestamps = new Float64Array(Math.min(256, rawHistory.timestamps.storedCount));
      copyLatestFromRingBuffer(rawHistory.timestamps, recentTimestamps);
      setLiveStatus({
        ratio: onsetDetector.current.currentRatio,
        phase: onsetDetector.current.phase,
        sampleRateHz: recentTimestamps.length > 20 ? estimateSampleRateHz(recentTimestamps) : null,
      });
    }, displayRefreshIntervalMilliseconds);
    return () => clearInterval(displayTimer);
  }, [isEnabled, stage, rawHistory]);

  /** Empieza (o repite) la sincronización: borra la referencia y las llegadas. */
  const startSync = useCallback(() => {
    onsetDetector.current.reset();
    syncTimestampSeconds.current = null;
    pendingWaveformCaptures.current = [];
    setRecordedArrivals([]);
    changeStage('waiting-sync');
  }, [changeStage]);

  /** El móvil ya está en su sitio: se reaprende el ruido de fondo y se esperan golpes. */
  const arm = useCallback(() => {
    if (syncTimestampSeconds.current === null) return;
    onsetDetector.current.reset();
    changeStage('armed');
  }, [changeStage]);

  const clearArrivals = useCallback(() => {
    pendingWaveformCaptures.current = [];
    setRecordedArrivals([]);
  }, []);

  const stop = useCallback(() => {
    syncTimestampSeconds.current = null;
    pendingWaveformCaptures.current = [];
    setRecordedArrivals([]);
    changeStage('idle');
  }, [changeStage]);

  return {
    stage,
    recordedArrivals,
    liveRatio: liveStatus.ratio,
    detectorPhase: liveStatus.phase,
    sampleRateHz: liveStatus.sampleRateHz,
    startSync,
    arm,
    clearArrivals,
    stop,
  };
}
