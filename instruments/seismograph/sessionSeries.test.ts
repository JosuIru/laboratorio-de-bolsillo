import { createSessionSeriesLog } from './sessionSeries';

describe('createSessionSeriesLog', () => {
  it('guarda toda la sesión aunque pase de la capacidad inicial', () => {
    const seriesLog = createSessionSeriesLog(20_000);
    for (let sampleIndex = 0; sampleIndex < 10_000; sampleIndex++) {
      seriesLog.push(sampleIndex / 200, sampleIndex, -sampleIndex, 9.8);
    }
    const series = seriesLog.read();
    expect(seriesLog.sampleCount).toBe(10_000);
    expect(seriesLog.isTruncated).toBe(false);
    expect(series.timestampsSeconds[0]).toBe(0);
    expect(series.timestampsSeconds[9999]).toBeCloseTo(49.995);
    expect(series.x[9999]).toBe(9999);
    expect(series.y[5000]).toBe(-5000);
  });

  it('deja de guardar al llegar al máximo y lo marca', () => {
    const seriesLog = createSessionSeriesLog(5000);
    for (let sampleIndex = 0; sampleIndex < 6000; sampleIndex++) seriesLog.push(sampleIndex, 0, 0, 0);
    expect(seriesLog.sampleCount).toBe(5000);
    expect(seriesLog.isTruncated).toBe(true);
    expect(seriesLog.read().timestampsSeconds.at(-1)).toBe(4999);
  });

  it('reiniciar la vacía', () => {
    const seriesLog = createSessionSeriesLog(100);
    seriesLog.push(1, 2, 3, 4);
    seriesLog.reset();
    expect(seriesLog.sampleCount).toBe(0);
    expect(seriesLog.read().x).toHaveLength(0);
  });
});
