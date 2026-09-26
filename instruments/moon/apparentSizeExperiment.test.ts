import { renderSyntheticMoon } from '@/processing/image/syntheticMoon.testHelpers';

import { measureDiameterForSizeExperiment, mergeSizeSeries, sizeMeasurementsFromHistory } from './apparentSizeExperiment';

describe('experimento del tamaño aparente', () => {
  it('mide el diámetro con precisión subpíxel y lo pasa a la escala común', () => {
    const trueRadius = 30.37;
    const moonImage = renderSyntheticMoon({
      width: 110,
      height: 110,
      centerX: 54.3,
      centerY: 55.6,
      radius: trueRadius,
      diskBrightness: 180,
      backgroundBrightness: 4,
      blurSigmaPixels: 1.2,
      noiseSigma: 1,
      subsamplesPerSide: 5,
    });
    // Resultado dos veces más fino que la escala común (superresolución por deriva, p. ej.).
    const measurement = measureDiameterForSizeExperiment(moonImage, 2)!;
    expect(measurement).not.toBeNull();
    expect(measurement.diameterPixels).toBeCloseTo(trueRadius, 0);
    expect(Math.abs(measurement.diameterPixels - trueRadius)).toBeLessThan(0.15);
    expect(measurement.diameterUncertaintyPixels).toBeGreaterThan(0);
    expect(measurement.diameterUncertaintyPixels).toBeLessThan(0.2);
  });

  it('lee las medidas guardadas y no mezcla JPEG con RAW', () => {
    const history = sizeMeasurementsFromHistory([
      { timestamp: 1_000_000, values: { experiment: 'apparentSize', measuredDiameterPixels: 28.1, diameterUncertaintyPixels: 0.1, sizeScaleSource: 'jpeg' } },
      { timestamp: 2_000_000, values: { experiment: 'earthAlbedo' } },
      { timestamp: 3_000_000, values: { experiment: 'apparentSize', measuredDiameterPixels: 29, diameterUncertaintyPixels: 0.1, sizeScaleSource: 'raw' } },
      { timestamp: 4_000_000, values: {} },
    ]);
    expect(history).toHaveLength(2);
    const session = [
      { date: new Date(5_000_000), diameterPixels: 28.3, diameterUncertaintyPixels: 0.1, source: 'jpeg' as const },
      // La misma que la primera del historial (ya guardada): no se repite.
      { date: new Date(1_000_200), diameterPixels: 28.1, diameterUncertaintyPixels: 0.1, source: 'jpeg' as const },
    ];
    const merged = mergeSizeSeries(session, history);
    expect(merged.map((measurement) => measurement.diameterPixels)).toEqual([28.1, 28.3]);
  });
});
