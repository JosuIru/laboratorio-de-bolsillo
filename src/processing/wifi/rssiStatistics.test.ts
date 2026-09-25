import { createSeededRandom } from '@/processing/dsp/signalGenerator';

import { classifySignalQuality, dbmToMilliwatts, milliwattsToDbm, summarizeRssiSamples } from './rssiStatistics';

describe('summarizeRssiSamples', () => {
  it('devuelve null sin muestras válidas y descarta el −127 de Android', () => {
    expect(summarizeRssiSamples([])).toBeNull();
    expect(summarizeRssiSamples([-127, Number.NaN])).toBeNull();
    expect(summarizeRssiSamples([-127, -60])?.sampleCount).toBe(1);
  });

  it('con una señal constante todo coincide y la dispersión es cero', () => {
    const summary = summarizeRssiSamples([-62, -62, -62, -62])!;
    expect(summary.meanDbm).toBeCloseTo(-62, 10);
    expect(summary.medianDbm).toBe(-62);
    expect(summary.standardDeviationDb).toBe(0);
  });

  it('promedia en potencia: la media queda por encima de la media aritmética en dBm', () => {
    const summary = summarizeRssiSamples([-50, -70])!;
    // (10 nW + 0,1 nW) / 2 → −53 dBm, no −60.
    expect(summary.meanDbm).toBeCloseTo(milliwattsToDbm((dbmToMilliwatts(-50) + dbmToMilliwatts(-70)) / 2), 10);
    expect(summary.meanDbm).toBeCloseTo(-52.97, 1);
    expect(summary.medianDbm).toBe(-60);
    expect(summary.minimumDbm).toBe(-70);
    expect(summary.maximumDbm).toBe(-50);
  });

  it('con ruido gaussiano la mediana recupera el valor verdadero', () => {
    const nextRandom = createSeededRandom(7);
    const noisySamples = Array.from({ length: 400 }, () => {
      // Box-Muller: desviación típica de 3 dB alrededor de −68 dBm.
      const gaussianNoise = Math.sqrt(-2 * Math.log(1 - nextRandom())) * Math.cos(2 * Math.PI * nextRandom());
      return Math.round(-68 + 3 * gaussianNoise);
    });
    const summary = summarizeRssiSamples(noisySamples)!;
    expect(Math.abs(summary.medianDbm + 68)).toBeLessThanOrEqual(1);
    expect(summary.standardDeviationDb).toBeGreaterThan(2);
    expect(summary.standardDeviationDb).toBeLessThan(4);
  });
});

describe('classifySignalQuality', () => {
  it('usa los umbrales habituales', () => {
    expect(classifySignalQuality(-45)).toBe('excellent');
    expect(classifySignalQuality(-60)).toBe('good');
    expect(classifySignalQuality(-67)).toBe('good');
    expect(classifySignalQuality(-72)).toBe('fair');
    expect(classifySignalQuality(-78)).toBe('poor');
    expect(classifySignalQuality(-85)).toBe('dead');
  });
});
