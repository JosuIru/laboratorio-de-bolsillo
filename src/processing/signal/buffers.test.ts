import { estimateSampleRateHz, resampleUniformly } from './resampling';
import { clearRingBuffer, copyLatestFromRingBuffer, createRingBuffer, pushToRingBuffer } from './ringBuffer';

describe('ringBuffer', () => {
  it('devuelve las últimas muestras en orden cronológico, también tras dar la vuelta', () => {
    const ringBuffer = createRingBuffer(4);
    for (const sampleValue of [1, 2, 3, 4, 5, 6]) pushToRingBuffer(ringBuffer, sampleValue);
    const output = new Float64Array(4);
    expect(copyLatestFromRingBuffer(ringBuffer, output)).toBe(4);
    expect(Array.from(output)).toEqual([3, 4, 5, 6]);

    const lastTwo = new Float64Array(2);
    copyLatestFromRingBuffer(ringBuffer, lastTwo);
    expect(Array.from(lastTwo)).toEqual([5, 6]);
  });

  it('copia menos muestras si todavía no hay suficientes', () => {
    const ringBuffer = createRingBuffer(8);
    pushToRingBuffer(ringBuffer, 7);
    pushToRingBuffer(ringBuffer, 8);
    const output = new Float64Array(5);
    expect(copyLatestFromRingBuffer(ringBuffer, output)).toBe(2);
    expect(Array.from(output.subarray(0, 2))).toEqual([7, 8]);
    clearRingBuffer(ringBuffer);
    expect(copyLatestFromRingBuffer(ringBuffer, output)).toBe(0);
  });

  it('rechaza capacidades no válidas', () => {
    expect(() => createRingBuffer(0)).toThrow(RangeError);
  });
});

describe('estimateSampleRateHz', () => {
  it('usa la mediana de los intervalos y no se deja engañar por un hueco', () => {
    const timestampsSeconds = [0, 0.01, 0.02, 0.03, 0.5, 0.51, 0.52];
    expect(estimateSampleRateHz(timestampsSeconds)).toBeCloseTo(100, 6);
  });

  it('devuelve null sin datos suficientes', () => {
    expect(estimateSampleRateHz([1])).toBeNull();
    expect(estimateSampleRateHz([1, 1, 1])).toBeNull();
  });
});

describe('resampleUniformly', () => {
  it('interpola linealmente sobre marcas irregulares', () => {
    const { values, startTimeSeconds } = resampleUniformly([10, 10.3, 11], [0, 3, 10], 10);
    expect(startTimeSeconds).toBe(10);
    expect(values).toHaveLength(11);
    expect(values[0]).toBeCloseTo(0);
    expect(values[2]).toBeCloseTo(2);
    expect(values[3]).toBeCloseTo(3);
    expect(values[10]).toBeCloseTo(10);
  });

  it('una senoidal con jitter se reconstruye con poco error', () => {
    const signalFrequencyHz = 2;
    const timestampsSeconds = Array.from(
      { length: 500 },
      (_, sampleIndex) => sampleIndex / 100 + (sampleIndex % 3 === 0 ? 0.002 : 0),
    );
    const sampleValues = timestampsSeconds.map((timeSeconds) => Math.sin(2 * Math.PI * signalFrequencyHz * timeSeconds));
    const { values, startTimeSeconds } = resampleUniformly(timestampsSeconds, sampleValues, 100);
    for (let outputIndex = 0; outputIndex < values.length; outputIndex++) {
      const exactValue = Math.sin(2 * Math.PI * signalFrequencyHz * (startTimeSeconds + outputIndex / 100));
      expect(Math.abs(values[outputIndex]! - exactValue)).toBeLessThan(0.01);
    }
  });

  it('valida la entrada', () => {
    expect(() => resampleUniformly([0, 1], [0], 10)).toThrow(RangeError);
    expect(() => resampleUniformly([0, 1], [0, 1], 0)).toThrow(RangeError);
    expect(resampleUniformly([], [], 10).values).toHaveLength(0);
  });
});
