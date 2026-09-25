/**
 * Estadísticas de muestras de RSSI (dBm). El promedio se hace en potencia (mW) y se vuelve a
 * dBm: promediar los dBm directamente sesga hacia abajo cuando la señal fluctúa.
 */

export interface RssiSummary {
  sampleCount: number;
  /** Media en potencia, expresada en dBm. */
  meanDbm: number;
  medianDbm: number;
  minimumDbm: number;
  maximumDbm: number;
  /** Desviación típica de los valores en dBm (cuánto baila la señal). */
  standardDeviationDb: number;
}

/** Android usa −127 como «RSSI no válido»; cualquier cosa fuera de este rango se descarta. */
export const minimumValidRssiDbm = -120;
export const maximumValidRssiDbm = 0;

export function isValidRssi(rssiDbm: number): boolean {
  return Number.isFinite(rssiDbm) && rssiDbm >= minimumValidRssiDbm && rssiDbm < maximumValidRssiDbm;
}

export function dbmToMilliwatts(powerDbm: number): number {
  return 10 ** (powerDbm / 10);
}

export function milliwattsToDbm(powerMilliwatts: number): number {
  return 10 * Math.log10(powerMilliwatts);
}

export function summarizeRssiSamples(rssiSamplesDbm: readonly number[]): RssiSummary | null {
  const validSamples = rssiSamplesDbm.filter(isValidRssi);
  if (validSamples.length === 0) return null;

  const sortedSamples = [...validSamples].sort((first, second) => first - second);
  const middleIndex = Math.floor(sortedSamples.length / 2);
  const medianDbm =
    sortedSamples.length % 2 === 1
      ? sortedSamples[middleIndex]!
      : (sortedSamples[middleIndex - 1]! + sortedSamples[middleIndex]!) / 2;

  const meanMilliwatts = validSamples.reduce((sum, sample) => sum + dbmToMilliwatts(sample), 0) / validSamples.length;
  const arithmeticMeanDbm = validSamples.reduce((sum, sample) => sum + sample, 0) / validSamples.length;
  const variance =
    validSamples.reduce((sum, sample) => sum + (sample - arithmeticMeanDbm) ** 2, 0) / validSamples.length;

  return {
    sampleCount: validSamples.length,
    meanDbm: milliwattsToDbm(meanMilliwatts),
    medianDbm,
    minimumDbm: sortedSamples[0]!,
    maximumDbm: sortedSamples[sortedSamples.length - 1]!,
    standardDeviationDb: Math.sqrt(variance),
  };
}

export type SignalQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'dead';

/**
 * Umbrales habituales: por encima de −67 dBm va bien hasta para videollamadas; por debajo de
 * −80 dBm la conexión se corta o va muy lenta (zona muerta).
 */
export const signalQualityThresholdsDbm = {
  excellent: -55,
  good: -67,
  fair: -75,
  poor: -80,
} as const;

/** Por debajo de esto se marca zona muerta en el mapa. */
export const deadZoneThresholdDbm = signalQualityThresholdsDbm.poor;

export function classifySignalQuality(rssiDbm: number): SignalQuality {
  if (rssiDbm >= signalQualityThresholdsDbm.excellent) return 'excellent';
  if (rssiDbm >= signalQualityThresholdsDbm.good) return 'good';
  if (rssiDbm >= signalQualityThresholdsDbm.fair) return 'fair';
  if (rssiDbm >= signalQualityThresholdsDbm.poor) return 'poor';
  return 'dead';
}
