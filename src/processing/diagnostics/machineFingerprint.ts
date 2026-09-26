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
  /**
   * Solo en una huella base de varias grabaciones: cuánto se aparta como mucho cada grabación de
   * la media, por banda y en el global (dB). Es la variación normal entre medidas (colocación,
   * ruido ambiente) y se descuenta al comparar.
   */
  bandSpreadDecibels?: number[];
  overallSpreadDecibels?: number;
}

export interface MachineFingerprint {
  audio: DomainFingerprint | null;
  vibration: DomainFingerprint | null;
  capturedAt: number;
  durationSeconds: number;
  /** Grabaciones combinadas en esta huella (1 si es una sola). */
  recordingCount?: number;
}

/** Más grabaciones en la huella base apenas afinan la dispersión y alargan el proceso. */
export const maximumBaselineRecordingCount = 5;

const decibelsToPower = (levelDecibels: number) => 10 ** (levelDecibels / 10);
const roundToHundredths = (value: number) => Math.round(value * 100) / 100;

function combineDomainRecordings(domainRecordings: readonly (DomainFingerprint | null)[]): DomainFingerprint | null {
  const firstRecording = domainRecordings.find((recording) => recording !== null);
  if (!firstRecording) return null;
  const compatibleRecordings = domainRecordings.filter(
    (recording): recording is DomainFingerprint =>
      recording !== null && recording.bandLevelsDecibels.length === firstRecording.bandLevelsDecibels.length,
  );
  if (compatibleRecordings.length === 1) return firstRecording;
  const meanLevel = (levels: number[]) =>
    powerToDecibels(levels.reduce((powerSum, level) => powerSum + decibelsToPower(level), 0) / levels.length);
  const spreadAround = (levels: number[], meanLevelDecibels: number) =>
    Math.max(...levels.map((level) => Math.abs(level - meanLevelDecibels)));

  const bandLevelsDecibels: number[] = [];
  const bandSpreadDecibels: number[] = [];
  firstRecording.bandLevelsDecibels.forEach((_level, bandIndex) => {
    const levels = compatibleRecordings.map((recording) => recording.bandLevelsDecibels[bandIndex]!);
    const combinedLevel = meanLevel(levels);
    bandLevelsDecibels.push(roundToHundredths(combinedLevel));
    bandSpreadDecibels.push(roundToHundredths(spreadAround(levels, combinedLevel)));
  });
  const overallLevels = compatibleRecordings.map((recording) => recording.overallLevelDecibels);
  const overallLevelDecibels = meanLevel(overallLevels);
  return {
    bandCentersHz: [...firstRecording.bandCentersHz],
    bandLevelsDecibels,
    overallLevelDecibels: roundToHundredths(overallLevelDecibels),
    frameCount: compatibleRecordings.reduce((frameSum, recording) => frameSum + recording.frameCount, 0),
    bandSpreadDecibels,
    overallSpreadDecibels: roundToHundredths(spreadAround(overallLevels, overallLevelDecibels)),
  };
}

/**
 * Une varias grabaciones de la máquina sana en una huella base: media en potencia y, por banda,
 * cuánto varían entre sí. Con una sola grabación no se sabe qué variación es normal.
 */
export function combineBaselineRecordings(recordings: readonly MachineFingerprint[]): MachineFingerprint | null {
  if (recordings.length === 0) return null;
  const latestRecording = recordings.reduce((latest, recording) => (recording.capturedAt > latest.capturedAt ? recording : latest));
  return {
    audio: combineDomainRecordings(recordings.map((recording) => recording.audio)),
    vibration: combineDomainRecordings(recordings.map((recording) => recording.vibration)),
    capturedAt: latestRecording.capturedAt,
    durationSeconds: recordings.reduce((durationSum, recording) => durationSum + recording.durationSeconds, 0),
    recordingCount: recordings.length,
  };
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
  /**
   * Subida (por encima de la variación normal de la huella base) a partir de la cual se vigila o
   * se alerta. En las bandas hace falta que suban al menos dos: una sola banda de unas 45 sube
   * por azar a menudo. Una sola solo cuenta si sube `singleBandExtraDecibels` más (un tono nuevo).
   */
  watchDeltaDecibels: number;
  alertDeltaDecibels: number;
  singleBandExtraDecibels: number;
}

export const defaultDiagnosisThresholds: DiagnosisThresholds = {
  noiseFloorDecibels: { audio: -100, vibration: -70 },
  watchDeltaDecibels: 3,
  alertDeltaDecibels: 6,
  singleBandExtraDecibels: 3,
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
): { overallDelta: number | null; overallExcess: number; deviations: BandDeviation[]; bandExcesses: number[] } {
  if (!baseline || !current) return { overallDelta: null, overallExcess: 0, deviations: [], bandExcesses: [] };
  const floorDecibels = thresholds.noiseFloorDecibels[domain];
  const deviations: BandDeviation[] = [];
  /** Subida de cada banda descontada su variación normal. */
  const bandExcesses: number[] = [];
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
    bandExcesses.push(deltaDecibels - (baseline.bandSpreadDecibels?.[bandIndex] ?? 0));
  });
  const overallDelta = Math.round((current.overallLevelDecibels - baseline.overallLevelDecibels) * 100) / 100;
  return {
    overallDelta,
    overallExcess: overallDelta - (baseline.overallSpreadDecibels ?? 0),
    deviations,
    bandExcesses,
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
  const verdictRank = { normal: 0, watch: 1, alert: 2 } as const;
  const verdictFor = (increase: number): DiagnosisVerdict =>
    increase >= thresholds.alertDeltaDecibels ? 'alert' : increase >= thresholds.watchDeltaDecibels ? 'watch' : 'normal';

  const overallVerdict = verdictFor(Math.max(0, audioComparison.overallExcess, vibrationComparison.overallExcess));
  // Una banda estrecha puede subir sin que suba el global (un tono nuevo), pero una sola banda
  // también sube por azar: cuenta la segunda que más sube, o la primera si sube de sobra.
  const sortedExcesses = [...audioComparison.bandExcesses, ...vibrationComparison.bandExcesses].sort(
    (leftExcess, rightExcess) => rightExcess - leftExcess,
  );
  const largestExcess = sortedExcesses[0] ?? 0;
  const secondLargestExcess = sortedExcesses[1] ?? 0;
  const bandVerdict = [
    verdictFor(secondLargestExcess),
    verdictFor(largestExcess - thresholds.singleBandExtraDecibels),
  ].reduce((worst, candidate) => (verdictRank[candidate] > verdictRank[worst] ? candidate : worst));
  const verdict = verdictRank[bandVerdict] > verdictRank[overallVerdict] ? bandVerdict : overallVerdict;
  return {
    verdict,
    overallDeltaDecibels: { audio: audioComparison.overallDelta, vibration: vibrationComparison.overallDelta },
    bandDeviations,
    largestIncreaseDecibels,
  };
}
