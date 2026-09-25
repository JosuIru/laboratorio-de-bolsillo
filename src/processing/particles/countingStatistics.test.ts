import {
  countingRate,
  countsForRelativeUncertainty,
  poissonConfidenceInterval,
  poissonCumulativeProbability,
  relativeCountingUncertainty,
} from './countingStatistics';

describe('poissonCumulativeProbability', () => {
  it('coincide con valores conocidos', () => {
    expect(poissonCumulativeProbability(0, 1)).toBeCloseTo(Math.exp(-1), 10);
    expect(poissonCumulativeProbability(2, 3)).toBeCloseTo(Math.exp(-3) * (1 + 3 + 4.5), 10);
    expect(poissonCumulativeProbability(-1, 3)).toBe(0);
    expect(poissonCumulativeProbability(5, 0)).toBe(1);
  });

  it('no desborda con recuentos grandes', () => {
    expect(poissonCumulativeProbability(1000, 1000)).toBeGreaterThan(0.5);
    expect(poissonCumulativeProbability(1000, 1000)).toBeLessThan(0.52);
  });
});

describe('poissonConfidenceInterval (Garwood, 68 %)', () => {
  it('con 0 sucesos: de 0 a 1,84', () => {
    const interval = poissonConfidenceInterval(0);
    expect(interval.lower).toBe(0);
    expect(interval.upper).toBeCloseTo(1.841, 2);
  });

  it('con pocos sucesos coincide con las tablas', () => {
    // Tabla de Gehrels (1986), 1σ: n=1 → 0,173-3,300; n=5 → 2,840-8,382.
    const oneEventInterval = poissonConfidenceInterval(1);
    expect(oneEventInterval.lower).toBeCloseTo(0.173, 2);
    expect(oneEventInterval.upper).toBeCloseTo(3.3, 1);
    const fiveEventInterval = poissonConfidenceInterval(5);
    expect(fiveEventInterval.lower).toBeCloseTo(2.84, 1);
    expect(fiveEventInterval.upper).toBeCloseTo(8.38, 1);
  });

  it('con muchos sucesos se parece a N ± √N', () => {
    const interval = poissonConfidenceInterval(400);
    expect(interval.lower).toBeCloseTo(380, -1);
    expect(interval.upper).toBeCloseTo(420, -1);
  });
});

describe('countingRate', () => {
  it('da la tasa por minuto con su incertidumbre', () => {
    const rate = countingRate(16, 32)!;
    expect(rate.ratePerMinute).toBe(0.5);
    expect(rate.standardUncertaintyPerMinute).toBe(4 / 32);
    expect(rate.lowerPerMinute).toBeLessThan(0.5);
    expect(rate.upperPerMinute).toBeGreaterThan(0.5);
  });

  it('sin tiempo no hay tasa', () => {
    expect(countingRate(3, 0)).toBeNull();
  });

  it('la incertidumbre relativa baja con la raíz del recuento', () => {
    expect(relativeCountingUncertainty(100)).toBeCloseTo(0.1, 10);
    expect(relativeCountingUncertainty(0)).toBe(Infinity);
    expect(countsForRelativeUncertainty(0.1)).toBe(100);
  });
});
