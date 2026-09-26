import { detectorBeepHeat } from './detectorBeep';

describe('detectorBeepHeat', () => {
  const triggerMicroteslas = 15;

  it('va de 0 lejos del metal a 1 encima, subiendo con ΔB', () => {
    expect(detectorBeepHeat(0, triggerMicroteslas)).toBe(0);
    expect(detectorBeepHeat(2, triggerMicroteslas)).toBe(0);
    expect(detectorBeepHeat(500, triggerMicroteslas)).toBe(1);
    const heats = [5, 10, 15, 30, 55].map((deviation) => detectorBeepHeat(deviation, triggerMicroteslas)!);
    heats.slice(1).forEach((heat, heatIndex) => expect(heat).toBeGreaterThan(heats[heatIndex]!));
  });

  it('en el umbral de aviso está a media escala', () => {
    expect(detectorBeepHeat(triggerMicroteslas, triggerMicroteslas)).toBeCloseTo(0.5, 5);
  });

  it('calla sin lectura', () => {
    expect(detectorBeepHeat(null, triggerMicroteslas)).toBeNull();
    expect(detectorBeepHeat(Number.NaN, triggerMicroteslas)).toBeNull();
  });
});
