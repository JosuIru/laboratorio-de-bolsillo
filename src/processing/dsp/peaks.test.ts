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

  it('con tiempos, una vibración amortiguada cuenta como un solo evento', () => {
    const sampleRateHz = 400;
    const vibrationFrequencyHz = 30;
    const decaySeconds = 0.3;
    // Dos golpes separados 2 s: senoides de 30 Hz que se amortiguan.
    const buildDampedVibration = (startSeconds: number) =>
      Array.from({ length: sampleRateHz * 2 }, (_, sampleIndex) => {
        const elapsedSeconds = sampleIndex / sampleRateHz;
        return {
          timestampSeconds: startSeconds + elapsedSeconds,
          value: 2 * Math.exp(-elapsedSeconds / decaySeconds) * Math.sin(2 * Math.PI * vibrationFrequencyHz * elapsedSeconds),
        };
      });
    const twoKnocks = [...buildDampedVibration(0), ...buildDampedVibration(2)];
    const countEvents = (eventDetector: ReturnType<typeof createEventDetector>, withTimestamps: boolean) =>
      twoKnocks.filter(({ timestampSeconds, value }) =>
        eventDetector.push(value, withTimestamps ? timestampSeconds : undefined),
      ).length;

    // Solo con histéresis, cada cruce por cero rearma: muchos «eventos» por golpe.
    expect(countEvents(createEventDetector(0.1, 0.05), false)).toBeGreaterThan(10);
    expect(
      countEvents(createEventDetector(0.1, 0.05, { refractorySeconds: 0.5, quietSecondsBeforeRearm: 0.2 }), true),
    ).toBe(2);
  });

  it('rechaza umbrales incoherentes', () => {
    expect(() => createEventDetector(1, 2)).toThrow(RangeError);
  });
});
