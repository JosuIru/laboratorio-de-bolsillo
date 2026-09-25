import {
  beepFrequencyHz,
  beepIntervalSeconds,
  compareHeatTrend,
  heatToLevel,
  isSignalLost,
  rssiToHeat,
  smoothRssi,
  type SmoothedRssi,
} from './proximity';

/** Generador pseudoaleatorio determinista (para ruido reproducible). */
function createSeededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('suavizado del RSSI', () => {
  it('la primera muestra se toma tal cual y un escalón se acerca con la constante de tiempo', () => {
    let smoothedRssi: SmoothedRssi | null = smoothRssi(null, -80, 0, 1);
    expect(smoothedRssi.valueDbm).toBe(-80);
    // Tras una constante de tiempo se ha recorrido el 63 % del escalón.
    smoothedRssi = smoothRssi(smoothedRssi, -60, 1000, 1);
    expect(smoothedRssi.valueDbm).toBeCloseTo(-80 + 20 * (1 - Math.exp(-1)), 6);
  });

  it('no depende de cuántos anuncios lleguen, sino del tiempo', () => {
    let fewSamples: SmoothedRssi | null = smoothRssi(null, -80, 0);
    fewSamples = smoothRssi(fewSamples, -60, 2000);
    let manySamples: SmoothedRssi | null = smoothRssi(null, -80, 0);
    for (let timestamp = 100; timestamp <= 2000; timestamp += 100) manySamples = smoothRssi(manySamples, -60, timestamp);
    expect(manySamples.valueDbm).toBeCloseTo(fewSamples.valueDbm, 6);
  });

  it('reduce mucho el ruido de un RSSI constante con ±8 dB', () => {
    const random = createSeededRandom(7);
    let smoothedRssi: SmoothedRssi | null = null;
    const smoothedValues: number[] = [];
    for (let sampleIndex = 0; sampleIndex < 400; sampleIndex += 1) {
      const noisyRssi = -70 + (random() * 2 - 1) * 8;
      smoothedRssi = smoothRssi(smoothedRssi, noisyRssi, sampleIndex * 200);
      if (sampleIndex > 50) smoothedValues.push(smoothedRssi.valueDbm);
    }
    // El ruido uniforme de ±8 dB tiene una desviación típica de 8/√3 ≈ 4,6 dB.
    const rootMeanSquareError = Math.sqrt(
      smoothedValues.reduce((sum, smoothedValue) => sum + (smoothedValue + 70) ** 2, 0) / smoothedValues.length,
    );
    expect(rootMeanSquareError).toBeLessThan(1.6);
  });
});

describe('escala frío / caliente', () => {
  it('lleva el RSSI a [0, 1] y a cuatro niveles', () => {
    expect(rssiToHeat(-110)).toBe(0);
    expect(rssiToHeat(-30)).toBe(1);
    expect(rssiToHeat(-70)).toBeCloseTo(0.5);
    expect(heatToLevel(rssiToHeat(-92))).toBe('cold');
    expect(heatToLevel(rssiToHeat(-78))).toBe('cool');
    expect(heatToLevel(rssiToHeat(-65))).toBe('warm');
    expect(heatToLevel(rssiToHeat(-50))).toBe('hot');
  });

  it('solo da tendencia si el cambio supera el ruido', () => {
    expect(compareHeatTrend(-70, null)).toBe('steady');
    expect(compareHeatTrend(-70, -71.5)).toBe('steady');
    expect(compareHeatTrend(-66, -72)).toBe('warmer');
    expect(compareHeatTrend(-78, -72)).toBe('colder');
  });

  it('pita más rápido y más agudo cuanto más cerca', () => {
    expect(beepIntervalSeconds(0)).toBeCloseTo(1.4);
    expect(beepIntervalSeconds(1)).toBeCloseTo(0.12);
    expect(beepIntervalSeconds(0.5)).toBeLessThan(beepIntervalSeconds(0.4));
    expect(beepFrequencyHz(0)).toBeCloseTo(440);
    expect(beepFrequencyHz(1)).toBeCloseTo(1760);
    expect(beepFrequencyHz(0.5)).toBeCloseTo(880);
  });

  it('detecta la pérdida de señal', () => {
    expect(isSignalLost(null, 0)).toBe(true);
    expect(isSignalLost(1000, 5000)).toBe(false);
    expect(isSignalLost(1000, 8000)).toBe(true);
  });
});
