/**
 * Prueba de hardware: el altavoz emite tonos de 15 a 22 kHz, uno tras otro, y se mide cuánto
 * sobresale cada uno del ruido en el micrófono. Muchos móviles cortan antes de 20 kHz en el
 * altavoz, en el micrófono o en ambos; esta prueba dice qué banda se puede usar.
 */

export const hardwareTestStartFrequencyHz = 15000;
export const hardwareTestEndFrequencyHz = 22000;
export const hardwareTestStepHz = 1000;

/** Frecuencias de la prueba que caben bajo Nyquist (con 500 Hz de margen). */
export function hardwareTestFrequenciesHz(sampleRateHz: number): number[] {
  const testFrequenciesHz: number[] = [];
  for (
    let frequencyHz = hardwareTestStartFrequencyHz;
    frequencyHz <= hardwareTestEndFrequencyHz;
    frequencyHz += hardwareTestStepHz
  ) {
    if (frequencyHz <= sampleRateHz / 2 - 500) testFrequenciesHz.push(frequencyHz);
  }
  return testFrequenciesHz;
}

/** Amplitud máxima del espectro a ±`toleranceBins` bins de una frecuencia. */
export function toneAmplitudeAt(
  amplitudeSpectrum: ArrayLike<number>,
  frequencyHz: number,
  sampleRateHz: number,
  fftSize: number,
  toleranceBins = 2,
): number {
  const centerBin = Math.round((frequencyHz * fftSize) / sampleRateHz);
  let maximumAmplitude = 0;
  for (let binIndex = centerBin - toleranceBins; binIndex <= centerBin + toleranceBins; binIndex++) {
    maximumAmplitude = Math.max(maximumAmplitude, amplitudeSpectrum[binIndex] ?? 0);
  }
  return maximumAmplitude;
}

export type BandReception = 'good' | 'weak' | 'none';

export const goodSignalToNoiseDecibels = 20;
export const weakSignalToNoiseDecibels = 8;

export function classifyBandReception(signalToNoiseDecibels: number): BandReception {
  if (signalToNoiseDecibels >= goodSignalToNoiseDecibels) return 'good';
  if (signalToNoiseDecibels >= weakSignalToNoiseDecibels) return 'weak';
  return 'none';
}

export interface HardwareBandResult {
  frequencyHz: number;
  signalToNoiseDecibels: number;
  reception: BandReception;
}

export function measureBandResult(
  frequencyHz: number,
  toneAmplitude: number,
  noiseAmplitude: number,
): HardwareBandResult {
  const signalToNoiseDecibels = 20 * Math.log10(Math.max(toneAmplitude, 1e-12) / Math.max(noiseAmplitude, 1e-12));
  return { frequencyHz, signalToNoiseDecibels, reception: classifyBandReception(signalToNoiseDecibels) };
}

export type SonarBandPreset = 'ultrasonic' | 'nearUltrasonic';

export const sonarBandPresets: Record<SonarBandPreset, { lowFrequencyHz: number; highFrequencyHz: number }> = {
  ultrasonic: { lowFrequencyHz: 18000, highFrequencyHz: 22000 },
  nearUltrasonic: { lowFrequencyHz: 16000, highFrequencyHz: 20000 },
};

export type HardwareVerdict = 'ultrasonicReady' | 'nearUltrasonicOnly' | 'notSupported';

export interface HardwareTestSummary {
  verdict: HardwareVerdict;
  recommendedPreset: SonarBandPreset | null;
  /** Frecuencia más alta que se recibe bien (o null si ninguna). */
  highestGoodFrequencyHz: number | null;
}

/**
 * Una banda sirve si al menos tres cuartas partes de sus tonos llegan (bien o flojos) y alguno
 * llega bien: el filtro adaptado aguanta que un extremo de la banda se pierda.
 */
function isBandUsable(
  bandResults: readonly HardwareBandResult[],
  lowFrequencyHz: number,
  highFrequencyHz: number,
): boolean {
  const resultsInBand = bandResults.filter(
    (bandResult) => bandResult.frequencyHz >= lowFrequencyHz && bandResult.frequencyHz <= highFrequencyHz,
  );
  if (resultsInBand.length === 0) return false;
  const receivedCount = resultsInBand.filter((bandResult) => bandResult.reception !== 'none').length;
  const hasGoodTone = resultsInBand.some((bandResult) => bandResult.reception === 'good');
  return hasGoodTone && receivedCount >= Math.ceil(resultsInBand.length * 0.75);
}

export function summarizeHardwareTest(bandResults: readonly HardwareBandResult[]): HardwareTestSummary {
  const goodFrequenciesHz = bandResults
    .filter((bandResult) => bandResult.reception === 'good')
    .map((bandResult) => bandResult.frequencyHz);
  const highestGoodFrequencyHz = goodFrequenciesHz.length > 0 ? Math.max(...goodFrequenciesHz) : null;
  const { ultrasonic, nearUltrasonic } = sonarBandPresets;
  if (isBandUsable(bandResults, ultrasonic.lowFrequencyHz, ultrasonic.highFrequencyHz)) {
    return { verdict: 'ultrasonicReady', recommendedPreset: 'ultrasonic', highestGoodFrequencyHz };
  }
  if (isBandUsable(bandResults, nearUltrasonic.lowFrequencyHz, nearUltrasonic.highFrequencyHz)) {
    return { verdict: 'nearUltrasonicOnly', recommendedPreset: 'nearUltrasonic', highestGoodFrequencyHz };
  }
  return { verdict: 'notSupported', recommendedPreset: null, highestGoodFrequencyHz };
}
