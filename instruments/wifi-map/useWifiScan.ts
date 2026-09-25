import { useCallback, useEffect, useRef, useState } from 'react';

import type { NeighborNetwork } from '@/processing/wifi/channelCongestion';
import { millisecondsUntilNextScan } from '@/processing/wifi/scanThrottle';
import { channelWidthMhzFromAndroidCode } from '@/processing/wifi/wifiBands';

import { getWifiScanResults, startWifiScan, type WifiScanResult } from '../../modules/wifi-signal';
import { scanResultsWaitMilliseconds } from './wifiMapConfiguration';

export type WifiScanStatus = 'idle' | 'scanning' | 'done' | 'throttled' | 'permission-missing';

/** Resultados más viejos que esto no se muestran (Android guarda los de escaneos antiguos). */
const maximumResultAgeMilliseconds = 5 * 60_000;

export function toNeighborNetwork(scanResult: WifiScanResult): NeighborNetwork {
  return {
    bssid: scanResult.bssid,
    ssid: scanResult.ssid,
    rssiDbm: scanResult.rssiDbm,
    frequencyMhz: scanResult.frequencyMhz,
    centerFrequencyMhz: scanResult.centerFrequencyMhz,
    channelWidthMhz: channelWidthMhzFromAndroidCode(scanResult.channelWidthCode),
  };
}

/**
 * Escaneo de redes vecinas bajo demanda, respetando el límite de Android (4 cada 2 minutos):
 * si no queda cupo se muestran los últimos resultados que tenga el sistema.
 */
export function useWifiScan(canScan: boolean) {
  const [neighborNetworks, setNeighborNetworks] = useState<NeighborNetwork[]>([]);
  const [scanStatus, setScanStatus] = useState<WifiScanStatus>('idle');
  const [scanTimestamps, setScanTimestamps] = useState<number[]>([]);
  const [currentTimeMilliseconds, setCurrentTimeMilliseconds] = useState(() => Date.now());
  const waitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readCachedResults = useCallback((): boolean => {
    const scanResults = getWifiScanResults();
    if (scanResults === null) {
      setScanStatus('permission-missing');
      return false;
    }
    setNeighborNetworks(
      scanResults.filter((scanResult) => scanResult.ageMs <= maximumResultAgeMilliseconds).map(toNeighborNetwork),
    );
    return true;
  }, []);

  // Al abrir, lo que ya tenga el sistema de sus escaneos periódicos.
  useEffect(() => {
    if (!canScan) return;
    const initialReadTimeout = setTimeout(readCachedResults, 0);
    return () => clearTimeout(initialReadTimeout);
  }, [canScan, readCachedResults]);

  const waitMilliseconds = millisecondsUntilNextScan(scanTimestamps, currentTimeMilliseconds);

  // Reloj para la cuenta atrás mientras no se puede escanear.
  useEffect(() => {
    if (waitMilliseconds <= 0) return;
    const clockInterval = setInterval(() => setCurrentTimeMilliseconds(Date.now()), 1000);
    return () => clearInterval(clockInterval);
  }, [waitMilliseconds]);

  useEffect(
    () => () => {
      if (waitTimeoutRef.current) clearTimeout(waitTimeoutRef.current);
    },
    [],
  );

  const requestScan = useCallback(() => {
    const nowMilliseconds = Date.now();
    setCurrentTimeMilliseconds(nowMilliseconds);
    if (millisecondsUntilNextScan(scanTimestamps, nowMilliseconds) > 0) {
      if (readCachedResults()) setScanStatus('throttled');
      return;
    }
    const wasAccepted = startWifiScan();
    setScanTimestamps((previousTimestamps) => [...previousTimestamps, nowMilliseconds]);
    setScanStatus('scanning');
    waitTimeoutRef.current = setTimeout(() => {
      waitTimeoutRef.current = null;
      if (readCachedResults()) setScanStatus(wasAccepted ? 'done' : 'throttled');
    }, scanResultsWaitMilliseconds);
  }, [scanTimestamps, readCachedResults]);

  return { neighborNetworks, scanStatus, requestScan, secondsUntilNextScan: Math.ceil(waitMilliseconds / 1000) };
}
