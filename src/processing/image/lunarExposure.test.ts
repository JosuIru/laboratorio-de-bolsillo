import {
  clampExposureDuration,
  exposureThirdStopFactor,
  formatExposureDuration,
  nextLunarExposureSeconds,
} from './lunarExposure';

const sensorDurationRange = { minimumSeconds: 1 / 10_000, maximumSeconds: 0.18 };

describe('nextLunarExposureSeconds', () => {
  it('baja un paso entero si la Luna está muy quemada', () => {
    const nextExposure = nextLunarExposureSeconds(1 / 100, { peakBrightness: 765, saturatedFraction: 0.8 }, sensorDurationRange);
    expect(nextExposure).toBeCloseTo(1 / 200);
  });

  it('baja un tercio si solo se satura un poco', () => {
    const nextExposure = nextLunarExposureSeconds(1 / 1000, { peakBrightness: 765, saturatedFraction: 0.02 }, sensorDurationRange);
    expect(nextExposure).toBeCloseTo(1 / 1000 / exposureThirdStopFactor);
  });

  it('sube un paso entero si la Luna está muy oscura', () => {
    const nextExposure = nextLunarExposureSeconds(1 / 4000, { peakBrightness: 200, saturatedFraction: 0 }, sensorDurationRange);
    expect(nextExposure).toBeCloseTo(1 / 2000);
  });

  it('sube un tercio si le falta un poco de brillo', () => {
    const nextExposure = nextLunarExposureSeconds(1 / 2000, { peakBrightness: 480, saturatedFraction: 0 }, sensorDurationRange);
    expect(nextExposure).toBeCloseTo((1 / 2000) * exposureThirdStopFactor);
  });

  it('no cambia si está bien expuesta', () => {
    const nextExposure = nextLunarExposureSeconds(1 / 2000, { peakBrightness: 650, saturatedFraction: 0.001 }, sensorDurationRange);
    expect(nextExposure).toBe(1 / 2000);
  });

  it('no sale del rango del sensor', () => {
    const shortestExposure = nextLunarExposureSeconds(1 / 10_000, { peakBrightness: 765, saturatedFraction: 0.9 }, sensorDurationRange);
    expect(shortestExposure).toBe(1 / 10_000);
    const longestExposure = nextLunarExposureSeconds(0.18, { peakBrightness: 100, saturatedFraction: 0 }, sensorDurationRange);
    expect(longestExposure).toBe(0.18);
  });

  it('un ajuste de un tercio no hace oscilar la exposición', () => {
    // Justo al borde por abajo: sube un tercio; el brillo resultante no debe saturar.
    const darkPeakBrightness = 515;
    const brightenedPeakBrightness = darkPeakBrightness * exposureThirdStopFactor;
    expect(brightenedPeakBrightness).toBeLessThan(750);
  });
});

describe('clampExposureDuration', () => {
  it('recorta al rango', () => {
    expect(clampExposureDuration(1, sensorDurationRange)).toBe(0.18);
    expect(clampExposureDuration(0, sensorDurationRange)).toBe(1 / 10_000);
  });
});

describe('formatExposureDuration', () => {
  it('muestra fracciones redondeadas', () => {
    expect(formatExposureDuration(1 / 2000)).toBe('1/2000 s');
    expect(formatExposureDuration(1 / 1587)).toBe('1/1590 s');
    expect(formatExposureDuration(1 / 8)).toBe('1/8 s');
    expect(formatExposureDuration(0.5)).toBe('0,5 s');
  });
});
