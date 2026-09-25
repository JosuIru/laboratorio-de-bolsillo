import { powerToDecibels } from '../dsp/frequencyBands';

/**
 * «Huella» acústica y de vibración de una máquina: el nivel medio de cada banda de frecuencia
 * durante unos segundos. Se graba con la máquina sana y luego se compara con el estado actual:
 * un rodamiento gastado, un desequilibrio o una correa floja suben el nivel de bandas concretas.
 */
export type FingerprintDomain = 'audio' | 'vibration';

export interface DomainFingerprint {
  bandCentersHz: number[];
  /** Nivel medio de cada banda en dB (audio: dBFS; vibración: dB re 1 m/s²). */
  bandLevelsDecibels: number[];
  /** Nivel global (suma de todas las bandas) en dB. */
  overallLevelDecibels: number;
  frameCount: number;
}

export interface MachineFingerprint {
  audio: DomainFingerprint | null;
  vibration: DomainFingerprint | null;
  capturedAt: number;
  durationSeconds: number;
}

/** Acumula tramas en potencia (no en dB) para que la media sea físicamente correcta. */
export function createDomainAccumulator(bandCentersHz: readonly number[]) {
  const powerSums = new Float64Array(bandCentersHz.length);
  let frameCount = 0;
  return {
    push(bandPowers: ArrayLike<number>): void {
      for (let bandIndex = 0; bandIndex < powerSums.length; bandIndex++) powerSums[bandIndex]! += bandPowers[bandIndex] ?? 0;
      frameCount++;
    },
    getFrameCount: () => frameCount,
    finish(): DomainFingerprint | null {
      if (frameCount === 0) return null;
      const meanPowers = Array.from(powerSums, (powerSum) => powerSum / frameCount);
      return {
        bandCentersHz: [...bandCentersHz],
        bandLevelsDecibels: meanPowers.map((meanPower) => Math.round(powerToDecibels(meanPower) * 100) / 100),
        overallLevelDecibels:
          Math.round(powerToDecibels(meanPowers.reduce((powerSum, power) => powerSum + power, 0)) * 100) / 100,
        frameCount,
      };
    },
  };
}

export interface BandDeviation {
  domain: FingerprintDomain;
  centerHz: number;
  /** Cambio de nivel en dB (positivo = más energía que en la huella sana). */
  deltaDecibels: number;
}

export type DiagnosisVerdict = 'normal' | 'watch' | 'alert';

export interface DiagnosisThresholds {
  /** Bandas por debajo de este nivel (dB) en ambas mediciones se ignoran: son ruido de fondo. */
  noiseFloorDecibels: Record<FingerprintDomain, number>;
  /** Subida de una banda o del nivel global a partir de la cual se vigila o se alerta. */
  watchDeltaDecibels: number;
  alertDeltaDecibels: number;
}

export const defaultDiagnosisThresholds: DiagnosisThresholds = {
  noiseFloorDecibels: { audio: -100, vibration: -70 },
  watchDeltaDecibels: 3,
  alertDeltaDecibels: 6,
};

export interface DiagnosisResult {
  verdict: DiagnosisVerdict;
  /** Cambio del nivel global por dominio (null si falta en alguna de las dos huellas). */
  overallDeltaDecibels: Record<FingerprintDomain, number | null>;
  /** Cambios por banda, de mayor a menor subida. */
  bandDeviations: BandDeviation[];
  /** Mayor subida de una banda significativa (0 si no hay ninguna). */
  largestIncreaseDecibels: number;
}

function compareDomain(
  domain: FingerprintDomain,
  baseline: DomainFingerprint | null,
  current: DomainFingerprint | null,
  thresholds: DiagnosisThresholds,
): { overallDelta: number | null; deviations: BandDeviation[] } {
  if (!baseline || !current) return { overallDelta: null, deviations: [] };
  const floorDecibels = thresholds.noiseFloorDecibels[domain];
  const deviations: BandDeviation[] = [];
  baseline.bandCentersHz.forEach((centerHz, bandIndex) => {
    const currentIndex = current.bandCentersHz.findIndex((candidateHz) => Math.abs(candidateHz / centerHz - 1) < 0.01);
    if (currentIndex < 0) return;
    const baselineLevel = baseline.bandLevelsDecibels[bandIndex]!;
    const currentLevel = current.bandLevelsDecibels[currentIndex]!;
    if (baselineLevel < floorDecibels && currentLevel < floorDecibels) return;
    // Por debajo del suelo se toma el suelo: si una banda aparece de la nada, el cambio es
    // «desde el ruido», no desde −200 dB.
    const deltaDecibels = Math.max(currentLevel, floorDecibels) - Math.max(baselineLevel, floorDecibels);
    deviations.push({ domain, centerHz, deltaDecibels: Math.round(deltaDecibels * 100) / 100 });
  });
  return {
    overallDelta: Math.round((current.overallLevelDecibels - baseline.overallLevelDecibels) * 100) / 100,
    deviations,
  };
}

export function compareFingerprints(
  baseline: MachineFingerprint,
  current: MachineFingerprint,
  thresholds: DiagnosisThresholds = defaultDiagnosisThresholds,
): DiagnosisResult {
  const audioComparison = compareDomain('audio', baseline.audio, current.audio, thresholds);
  const vibrationComparison = compareDomain('vibration', baseline.vibration, current.vibration, thresholds);
  const bandDeviations = [...audioComparison.deviations, ...vibrationComparison.deviations].sort(
    (leftDeviation, rightDeviation) => rightDeviation.deltaDecibels - leftDeviation.deltaDecibels,
  );
  const largestIncreaseDecibels = Math.max(0, bandDeviations[0]?.deltaDecibels ?? 0);
  const largestOverallIncrease = Math.max(0, audioComparison.overallDelta ?? 0, vibrationComparison.overallDelta ?? 0);
  // Una banda estrecha puede subir sin que suba el global (un tono nuevo): cuenta cualquiera.
  const worstIncrease = Math.max(largestIncreaseDecibels, largestOverallIncrease);
  const verdict: DiagnosisVerdict =
    worstIncrease >= thresholds.alertDeltaDecibels
      ? 'alert'
      : worstIncrease >= thresholds.watchDeltaDecibels
        ? 'watch'
        : 'normal';
  return {
    verdict,
    overallDeltaDecibels: { audio: audioComparison.overallDelta, vibration: vibrationComparison.overallDelta },
    bandDeviations,
    largestIncreaseDecibels,
  };
}
