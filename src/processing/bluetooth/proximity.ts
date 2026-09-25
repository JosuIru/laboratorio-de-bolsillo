/**
 * Medidor de proximidad «frío / caliente» a partir del RSSI. El RSSI de BLE es muy ruidoso
 * (±6-10 dB por reflexiones, orientación y el cuerpo de quien sujeta el móvil), así que se
 * suaviza en el tiempo y se muestra como una escala relativa, no como una distancia.
 */

export interface SmoothedRssi {
  valueDbm: number;
  timestampMilliseconds: number;
}

/** Constante de tiempo de la media exponencial: más grande, más estable pero más lento. */
export const defaultRssiTimeConstantSeconds = 1.5;

/**
 * Media exponencial con constante de tiempo real: los anuncios llegan a intervalos irregulares,
 * así que el peso depende del tiempo transcurrido y no del número de muestras.
 */
export function smoothRssi(
  previousRssi: SmoothedRssi | null,
  rssiDbm: number,
  timestampMilliseconds: number,
  timeConstantSeconds = defaultRssiTimeConstantSeconds,
): SmoothedRssi {
  if (!previousRssi) return { valueDbm: rssiDbm, timestampMilliseconds };
  const elapsedSeconds = Math.max(0, (timestampMilliseconds - previousRssi.timestampMilliseconds) / 1000);
  const newSampleWeight = 1 - Math.exp(-elapsedSeconds / timeConstantSeconds);
  return {
    valueDbm: previousRssi.valueDbm + newSampleWeight * (rssiDbm - previousRssi.valueDbm),
    timestampMilliseconds: Math.max(previousRssi.timestampMilliseconds, timestampMilliseconds),
  };
}

/** RSSI típico a varios metros o tras paredes. */
export const coldRssiDbm = -95;
/** RSSI típico con el rastreador pegado al móvil. */
export const hotRssiDbm = -45;

/** Pasa el RSSI a un «calor» entre 0 (lejos) y 1 (pegado). */
export function rssiToHeat(rssiDbm: number): number {
  const heat = (rssiDbm - coldRssiDbm) / (hotRssiDbm - coldRssiDbm);
  return Math.min(1, Math.max(0, heat));
}

export type HeatLevel = 'cold' | 'cool' | 'warm' | 'hot';

export function heatToLevel(heat: number): HeatLevel {
  if (heat >= 0.75) return 'hot';
  if (heat >= 0.5) return 'warm';
  if (heat >= 0.25) return 'cool';
  return 'cold';
}

export type HeatTrend = 'warmer' | 'colder' | 'steady';

/** Diferencia de RSSI suavizado que cuenta como cambio real y no como ruido. */
export const trendThresholdDb = 3;

export function compareHeatTrend(currentRssiDbm: number, referenceRssiDbm: number | null): HeatTrend {
  if (referenceRssiDbm === null) return 'steady';
  const rssiDifference = currentRssiDbm - referenceRssiDbm;
  if (rssiDifference >= trendThresholdDb) return 'warmer';
  if (rssiDifference <= -trendThresholdDb) return 'colder';
  return 'steady';
}

/** Pitidos tipo contador Geiger: más seguidos y más agudos cuanto más cerca. */
export function beepIntervalSeconds(heat: number): number {
  const slowestIntervalSeconds = 1.4;
  const fastestIntervalSeconds = 0.12;
  const clampedHeat = Math.min(1, Math.max(0, heat));
  // Interpolación geométrica: los cambios se notan igual cerca y lejos.
  return slowestIntervalSeconds * (fastestIntervalSeconds / slowestIntervalSeconds) ** clampedHeat;
}

export function beepFrequencyHz(heat: number): number {
  const lowestFrequencyHz = 440;
  const highestFrequencyHz = 1760;
  const clampedHeat = Math.min(1, Math.max(0, heat));
  return lowestFrequencyHz * (highestFrequencyHz / lowestFrequencyHz) ** clampedHeat;
}

/** Sin anuncios durante este tiempo, el medidor avisa de que ha perdido la señal. */
export const signalLostAfterMilliseconds = 6_000;

export function isSignalLost(lastSeenMilliseconds: number | null, nowMilliseconds: number): boolean {
  return lastSeenMilliseconds === null || nowMilliseconds - lastSeenMilliseconds > signalLostAfterMilliseconds;
}
