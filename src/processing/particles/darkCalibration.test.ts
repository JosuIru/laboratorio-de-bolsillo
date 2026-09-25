import {
  adaptThresholdOffset,
  countPixelOccurrences,
  isCameraCovered,
  mergeHotPixelIndices,
  neighbourhoodPixelIndices,
  registerEventPeak,
  selectHotPixels,
  summarizeDarkHistogram,
  thresholdOffsetFromNoise,
} from './darkCalibration';

function histogramFromValues(brightnessValues: readonly number[]): Uint32Array {
  const histogram = new Uint32Array(256);
  for (const brightness of brightnessValues) histogram[brightness]!++;
  return histogram;
}

describe('summarizeDarkHistogram', () => {
  it('calcula media, mediana y dispersión de un ruido conocido', () => {
    // Mitad a 4 y mitad a 6: media 5, desviación típica 1.
    const brightnessValues = [...Array<number>(50_000).fill(4), ...Array<number>(50_000).fill(6)];
    const noiseSummary = summarizeDarkHistogram(histogramFromValues(brightnessValues));
    expect(noiseSummary.sampleCount).toBe(100_000);
    expect(noiseSummary.meanBrightness).toBeCloseTo(5, 6);
    expect(noiseSummary.medianBrightness).toBe(4);
    expect(noiseSummary.trimmedStandardDeviation).toBeCloseTo(1, 3);
  });

  it('los píxeles calientes y los impactos (la cola brillante) no inflan la dispersión', () => {
    const brightnessValues = [...Array<number>(99_995).fill(3), ...Array<number>(5).fill(255)];
    const noiseSummary = summarizeDarkHistogram(histogramFromValues(brightnessValues));
    expect(noiseSummary.trimmedStandardDeviation).toBe(0);
    expect(noiseSummary.meanBrightness).toBeGreaterThan(3);
  });

  it('un histograma vacío da ceros', () => {
    expect(summarizeDarkHistogram(new Uint32Array(256)).sampleCount).toBe(0);
  });
});

describe('umbral', () => {
  it('usa varias sigmas del ruido, con un mínimo para los sensores que recortan el negro a 0', () => {
    const baseSummary = { sampleCount: 1, meanBrightness: 2, medianBrightness: 2 };
    expect(thresholdOffsetFromNoise({ ...baseSummary, trimmedStandardDeviation: 0 })).toBe(16);
    expect(thresholdOffsetFromNoise({ ...baseSummary, trimmedStandardDeviation: 4 })).toBe(28);
    expect(thresholdOffsetFromNoise({ ...baseSummary, trimmedStandardDeviation: 100 })).toBe(160);
  });

  it('se sube cuando salen demasiados sucesos y nunca se baja', () => {
    expect(adaptThresholdOffset(20, 1, 100)).toBe(20);
    expect(adaptThresholdOffset(20, 30, 100)).toBe(25);
    expect(adaptThresholdOffset(150, 300, 100)).toBe(160);
    expect(adaptThresholdOffset(20, 5, 0)).toBe(20);
  });

  it('da la cámara por tapada solo si el negro es bajo', () => {
    expect(isCameraCovered(3)).toBe(true);
    expect(isCameraCovered(80)).toBe(false);
  });
});

describe('píxeles calientes', () => {
  it('marca los que se repiten y no los impactos sueltos', () => {
    const occurrenceCounts = new Map<number, number>();
    countPixelOccurrences(occurrenceCounts, [100, 2000, 55]);
    countPixelOccurrences(occurrenceCounts, [2000, 55]);
    countPixelOccurrences(occurrenceCounts, [2000, 7]);
    expect(Array.from(selectHotPixels(occurrenceCounts, 2))).toEqual([55, 2000]);
  });

  it('une listas ordenadas sin duplicar', () => {
    expect(Array.from(mergeHotPixelIndices(Int32Array.from([5, 9]), [9, 1, 20]))).toEqual([1, 5, 9, 20]);
  });

  it('los vecinos se quedan dentro del fotograma', () => {
    expect(neighbourhoodPixelIndices(0, 10, 10).sort((first, second) => first - second)).toEqual([0, 1, 10, 11]);
    expect(neighbourhoodPixelIndices(55, 10, 10)).toHaveLength(9);
  });

  it('un píxel que da sucesos una y otra vez (o sus vecinos) pasa a caliente', () => {
    const peakOccurrenceCounts = new Map<number, number>();
    const frameWidth = 100;
    const frameHeight = 100;
    expect(registerEventPeak(peakOccurrenceCounts, 505, frameWidth, frameHeight, 3)).toBe(false);
    expect(registerEventPeak(peakOccurrenceCounts, 506, frameWidth, frameHeight, 3)).toBe(false);
    expect(registerEventPeak(peakOccurrenceCounts, 505, frameWidth, frameHeight, 3)).toBe(true);
    expect(registerEventPeak(peakOccurrenceCounts, 9000, frameWidth, frameHeight, 3)).toBe(false);
  });
});
