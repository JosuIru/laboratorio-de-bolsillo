/**
 * Bandas, canales y estándares Wi‑Fi a partir de lo que devuelve Android (frecuencias en MHz,
 * anchos de canal y estándares como enteros de la API).
 */

export type WifiBand = '2.4GHz' | '5GHz' | '6GHz';

export interface WifiChannel {
  band: WifiBand;
  channelNumber: number;
}

/** Banda y número de canal de una frecuencia central de 20 MHz. `null` si no es Wi‑Fi. */
export function channelFromFrequency(frequencyMhz: number): WifiChannel | null {
  if (!Number.isFinite(frequencyMhz)) return null;
  if (frequencyMhz === 2484) return { band: '2.4GHz', channelNumber: 14 };
  if (frequencyMhz >= 2412 && frequencyMhz <= 2472) {
    return { band: '2.4GHz', channelNumber: Math.round((frequencyMhz - 2407) / 5) };
  }
  // El canal 2 de 6 GHz es un caso especial (5935 MHz).
  if (frequencyMhz === 5935) return { band: '6GHz', channelNumber: 2 };
  if (frequencyMhz >= 5955 && frequencyMhz <= 7115) {
    return { band: '6GHz', channelNumber: Math.round((frequencyMhz - 5950) / 5) };
  }
  if (frequencyMhz >= 5160 && frequencyMhz <= 5905) {
    return { band: '5GHz', channelNumber: Math.round((frequencyMhz - 5000) / 5) };
  }
  return null;
}

/** Frecuencia central (MHz) de un canal de 20 MHz. */
export function frequencyFromChannel(channel: WifiChannel): number {
  switch (channel.band) {
    case '2.4GHz':
      return channel.channelNumber === 14 ? 2484 : 2407 + channel.channelNumber * 5;
    case '5GHz':
      return 5000 + channel.channelNumber * 5;
    case '6GHz':
      return channel.channelNumber === 2 ? 5935 : 5950 + channel.channelNumber * 5;
  }
}

/**
 * Ancho de canal en MHz a partir de `ScanResult.channelWidth` de Android
 * (0 = 20, 1 = 40, 2 = 80, 3 = 160, 4 = 80+80, 5 = 320). Desconocido → 20.
 */
export function channelWidthMhzFromAndroidCode(channelWidthCode: number): number {
  switch (channelWidthCode) {
    case 1:
      return 40;
    case 2:
      return 80;
    case 3:
    case 4:
      return 160;
    case 5:
      return 320;
    default:
      return 20;
  }
}

/**
 * Nombre comercial del estándar a partir de `WifiInfo.getWifiStandard()` / `ScanResult.getWifiStandard()`
 * (Android 11+): 1 = heredado (a/b/g), 4 = n, 5 = ac, 6 = ax, 7 = ad, 8 = be. `null` si no se sabe.
 */
export function wifiStandardLabel(androidWifiStandard: number | null | undefined): string | null {
  switch (androidWifiStandard) {
    case 1:
      return '802.11a/b/g';
    case 4:
      return 'Wi‑Fi 4 (802.11n)';
    case 5:
      return 'Wi‑Fi 5 (802.11ac)';
    case 6:
      return 'Wi‑Fi 6 (802.11ax)';
    case 7:
      return 'WiGig (802.11ad)';
    case 8:
      return 'Wi‑Fi 7 (802.11be)';
    default:
      return null;
  }
}

/** Canales de 20 MHz que tiene sentido recomendar en cada banda (Europa). */
export const recommendableChannelsByBand: Record<Exclude<WifiBand, '6GHz'>, readonly number[]> = {
  // Solo los tres canales que no se solapan entre sí.
  '2.4GHz': [1, 6, 11],
  '5GHz': [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140],
};

/** Canales de 5 GHz con DFS: el router debe comprobar que no hay radares y puede cambiar solo. */
export function isDfsChannel(channel: WifiChannel): boolean {
  return channel.band === '5GHz' && channel.channelNumber >= 52 && channel.channelNumber <= 144;
}
