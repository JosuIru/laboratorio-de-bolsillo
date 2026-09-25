import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/** Conexión Wi‑Fi actual tal como la da Android. */
export interface WifiConnectionInfo {
  rssiDbm: number;
  linkSpeedMbps: number | null;
  txLinkSpeedMbps: number | null;
  rxLinkSpeedMbps: number | null;
  maxLinkSpeedMbps: number | null;
  frequencyMhz: number;
  /** `WifiInfo.getWifiStandard()` (Android 11+), o null. */
  wifiStandard: number | null;
  /** null sin permiso de ubicación. */
  ssid: string | null;
  bssid: string | null;
  /** Milisegundos desde el arranque del móvil. */
  elapsedRealtimeMs: number;
}

export interface WifiScanResult {
  bssid: string;
  ssid: string | null;
  rssiDbm: number;
  frequencyMhz: number;
  centerFrequencyMhz: number | null;
  /** `ScanResult.channelWidth`: 0 = 20, 1 = 40, 2 = 80, 3 = 160, 4 = 80+80, 5 = 320 MHz. */
  channelWidthCode: number;
  wifiStandard: number | null;
  /** Antigüedad del resultado en milisegundos. */
  ageMs: number;
}

interface WifiSignalNativeModule {
  isWifiEnabled(): boolean;
  getConnectionInfo(): WifiConnectionInfo | null;
  startScan(): boolean;
  getScanResults(): WifiScanResult[] | null;
}

/** Solo existe en Android con un build que incluya el módulo (no en iOS, web ni Expo Go). */
const nativeWifiSignal =
  Platform.OS === 'android' ? requireOptionalNativeModule<WifiSignalNativeModule>('WifiSignal') : null;

export const isWifiSignalAvailable = nativeWifiSignal !== null;

export function isWifiEnabled(): boolean {
  return nativeWifiSignal?.isWifiEnabled() ?? false;
}

export function getWifiConnectionInfo(): WifiConnectionInfo | null {
  return nativeWifiSignal?.getConnectionInfo() ?? null;
}

/** Pide un escaneo. Devuelve false si Android lo rechaza (límite de 4 cada 2 minutos). */
export function startWifiScan(): boolean {
  return nativeWifiSignal?.startScan() ?? false;
}

/** Últimos resultados de escaneo; null si falta el permiso o no hay módulo. */
export function getWifiScanResults(): WifiScanResult[] | null {
  return nativeWifiSignal?.getScanResults() ?? null;
}
