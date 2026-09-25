import { millisecondsUntilNextScan, pruneScanTimestamps } from './scanThrottle';

describe('límite de escaneos de Android', () => {
  it('deja escanear mientras haya menos de 4 en los últimos 2 minutos', () => {
    expect(millisecondsUntilNextScan([], 1_000_000)).toBe(0);
    expect(millisecondsUntilNextScan([0, 10_000, 20_000], 30_000)).toBe(0);
  });

  it('con 4 recientes hay que esperar a que caduque el más antiguo', () => {
    expect(millisecondsUntilNextScan([0, 10_000, 20_000, 30_000], 40_000)).toBe(80_000);
    expect(millisecondsUntilNextScan([0, 10_000, 20_000, 30_000], 120_000)).toBe(0);
  });

  it('ignora el orden y los escaneos viejos', () => {
    expect(millisecondsUntilNextScan([30_000, 0, 20_000, 10_000, -500_000], 60_000)).toBe(60_000);
    expect(pruneScanTimestamps([-500_000, 0, 50_000], 60_000)).toEqual([0, 50_000]);
  });
});
