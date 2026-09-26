import { useCallback, useEffect, useRef, useState } from 'react';

import { useIsAppActive } from '@/core/useIsAppActive';
import { copyLatestFromRingBuffer, createRingBuffer, pushToRingBuffer } from '@/processing/signal/ringBuffer';
import { isValidRssi } from '@/processing/wifi/rssiStatistics';

import {
  getWifiConnectionInfo,
  isWifiEnabled,
  isWifiSignalAvailable,
  type WifiConnectionInfo,
} from '../../modules/wifi-signal';
import { connectionPollIntervalMilliseconds, rssiChartSampleCount } from './wifiMapConfiguration';

export interface WifiConnectionSnapshot {
  revision: number;
  isWifiEnabled: boolean;
  connection: WifiConnectionInfo | null;
  /** Últimos valores de RSSI, de más antiguo a más reciente. */
  chartValues: Float64Array;
  chartSampleCount: number;
}

type RssiCollector = (rssiDbm: number, bssid: string | null) => void;

/** Lecturas recogidas en un punto y los puntos de acceso (BSSID) que las dieron. */
export interface CollectedRssiSamples {
  rssiSamples: number[];
  /** BSSID distintos vistos durante la medida (vacío si Android no los da, sin permiso de ubicación). */
  observedBssids: string[];
}

/**
 * Consulta la conexión Wi‑Fi cada 500 ms mientras la pantalla está activa. Además permite
 * recoger las lecturas de unos segundos para promediarlas en un punto del mapa.
 */
export function useWifiConnection(isRunning: boolean) {
  const isAppActive = useIsAppActive();
  const [rssiHistory] = useState(() => createRingBuffer(rssiChartSampleCount));
  const [chartValues] = useState(() => new Float64Array(rssiChartSampleCount));
  const [snapshot, setSnapshot] = useState<WifiConnectionSnapshot>(() => ({
    revision: 0,
    isWifiEnabled: true,
    connection: null,
    chartValues,
    chartSampleCount: 0,
  }));
  const activeCollectorsRef = useRef(new Set<RssiCollector>());
  const pendingTimeoutsRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  const isPolling = isRunning && isAppActive && isWifiSignalAvailable;

  useEffect(() => {
    if (!isPolling) return;
    const activeCollectors = activeCollectorsRef.current;
    function pollConnection() {
      const connection = getWifiConnectionInfo();
      if (connection && isValidRssi(connection.rssiDbm)) {
        pushToRingBuffer(rssiHistory, connection.rssiDbm);
        activeCollectors.forEach((collectSample) => collectSample(connection.rssiDbm, connection.bssid));
      }
      const chartSampleCount = copyLatestFromRingBuffer(rssiHistory, chartValues);
      setSnapshot((previousSnapshot) => ({
        revision: previousSnapshot.revision + 1,
        isWifiEnabled: isWifiEnabled(),
        connection,
        chartValues,
        chartSampleCount,
      }));
    }
    pollConnection();
    const pollInterval = setInterval(pollConnection, connectionPollIntervalMilliseconds);
    return () => clearInterval(pollInterval);
  }, [isPolling, rssiHistory, chartValues]);

  useEffect(() => {
    const activeCollectors = activeCollectorsRef.current;
    const pendingTimeouts = pendingTimeoutsRef.current;
    return () => {
      pendingTimeouts.forEach((pendingTimeout) => clearTimeout(pendingTimeout));
      pendingTimeouts.clear();
      activeCollectors.clear();
    };
  }, []);

  /** Recoge las lecturas de RSSI durante `durationMilliseconds` y las devuelve con sus BSSID. */
  const collectRssiSamples = useCallback((durationMilliseconds: number) => {
    return new Promise<CollectedRssiSamples>((resolve) => {
      const collectedSamples: number[] = [];
      const observedBssids = new Set<string>();
      const collectSample: RssiCollector = (rssiDbm, bssid) => {
        collectedSamples.push(rssiDbm);
        if (bssid) observedBssids.add(bssid);
      };
      activeCollectorsRef.current.add(collectSample);
      const finishTimeout = setTimeout(() => {
        activeCollectorsRef.current.delete(collectSample);
        pendingTimeoutsRef.current.delete(finishTimeout);
        resolve({ rssiSamples: collectedSamples, observedBssids: [...observedBssids] });
      }, durationMilliseconds);
      pendingTimeoutsRef.current.add(finishTimeout);
    });
  }, []);

  return { snapshot, collectRssiSamples, isPolling };
}
