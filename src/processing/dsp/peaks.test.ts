import { createEventDetector, detectPeaks } from './peaks';

describe('detectPeaks', () => {
  it('encuentra máximos locales por encima del umbral', () => {
    const samples = [0, 1, 5, 1, 0, 0.5, 0, 3, 0];
    expect(detectPeaks(samples, { threshold: 2, minimumDistanceSamples: 1 })).toEqual([
      { sampleIndex: 2, value: 5 },
      { sampleIndex: 7, value: 3 },
    ]);
  });

  it('considera los valores negativos en valor absoluto', () => {
    expect(detectPeaks([0, -4, 0, 2, 0], { threshold: 1, minimumDistanceSamples: 1 })).toEqual([
      { sampleIndex: 1, value: 4 },
      { sampleIndex: 3, value: 2 },
    ]);
    expect(detectPeaks([0, -4, 0, 2, 0], { threshold: 1, minimumDistanceSamples: 1, useAbsoluteValue: false })).toEqual([
      { sampleIndex: 3, value: 2 },
    ]);
  });

  it('entre dos picos demasiado cercanos se queda con el mayor', () => {
    const samples = [0, 3, 0, 5, 0, 0, 0, 0, 4, 0];
    expect(detectPeaks(samples, { threshold: 1, minimumDistanceSamples: 4 })).toEqual([
      { sampleIndex: 3, value: 5 },
      { sampleIndex: 8, value: 4 },
    ]);
  });

  it('en una meseta cuenta un solo pico', () => {
    expect(detectPeaks([0, 2, 2, 2, 0], { threshold: 1, minimumDistanceSamples: 1 })).toEqual([
      { sampleIndex: 1, value: 2 },
    ]);
  });
});

describe('createEventDetector', () => {
  it('dispara una vez por evento gracias a la histéresis', () => {
    const eventDetector = createEventDetector(1, 0.3);
    const triggerFlags = [0, 1.2, 1.5, 0.8, 1.1, 0.2, 1.3].map((sampleValue) => eventDetector.push(sampleValue));
    expect(triggerFlags).toEqual([false, true, false, false, false, false, true]);
  });

  it('rechaza umbrales incoherentes', () => {
    expect(() => createEventDetector(1, 2)).toThrow(RangeError);
  });
});
