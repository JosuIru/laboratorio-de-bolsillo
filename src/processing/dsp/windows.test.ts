import { applyWindow, createWindow } from './windows';

describe('createWindow', () => {
  it('Hann: empieza en 0, vale 1 en el centro y tiene ganancia coherente 0,5', () => {
    const hannWindow = createWindow('hann', 8);
    expect(hannWindow.coefficients[0]).toBeCloseTo(0);
    expect(hannWindow.coefficients[4]).toBeCloseTo(1);
    expect(hannWindow.coherentGain).toBeCloseTo(0.5);
    expect(hannWindow.equivalentNoiseBandwidthBins).toBeCloseTo(1.5);
  });

  it('valores conocidos de ganancia coherente y ENBW', () => {
    expect(createWindow('rectangular', 64)).toMatchObject({ coherentGain: 1, equivalentNoiseBandwidthBins: 1 });
    expect(createWindow('hamming', 1024).coherentGain).toBeCloseTo(0.54, 6);
    expect(createWindow('blackman', 1024).coherentGain).toBeCloseTo(0.42, 6);
    expect(createWindow('blackman', 1024).equivalentNoiseBandwidthBins).toBeCloseTo(1.727, 3);
  });

  it('es simétrica (periódica: w[n] = w[N−n])', () => {
    const blackmanWindow = createWindow('blackman', 16);
    for (let sampleIndex = 1; sampleIndex < 16; sampleIndex++) {
      expect(blackmanWindow.coefficients[sampleIndex]).toBeCloseTo(blackmanWindow.coefficients[16 - sampleIndex]!, 12);
    }
  });

  it('rechaza tamaños no válidos', () => {
    expect(() => createWindow('hann', 0)).toThrow(RangeError);
    expect(() => createWindow('hann', 2.5)).toThrow(RangeError);
  });
});

describe('applyWindow', () => {
  it('multiplica muestra a muestra y admite trabajar in situ', () => {
    const samples = new Float64Array([2, 2, 2, 2]);
    applyWindow(samples, new Float64Array([0, 0.5, 1, 0.5]), samples);
    expect(Array.from(samples)).toEqual([0, 1, 2, 1]);
  });
});
