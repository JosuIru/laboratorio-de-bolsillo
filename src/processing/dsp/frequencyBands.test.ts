import {
  bandPowersFromAmplitudeSpectrum,
  createFractionalOctaveBands,
  formatBandCenter,
  powerToDecibels,
} from './frequencyBands';

describe('createFractionalOctaveBands', () => {
  it('tercios de octava: centros normalizados y bandas contiguas', () => {
    const thirdOctaveBands = createFractionalOctaveBands(3, 100, 1000);
    expect(thirdOctaveBands.map((band) => formatBandCenter(band.centerHz))).toEqual([
      '100',
      '125',
      '160',
      '200',
      '250',
      '315',
      '400',
      '500',
      '630',
      '800',
      '1k',
    ]);
    for (let bandIndex = 1; bandIndex < thirdOctaveBands.length; bandIndex++) {
      expect(thirdOctaveBands[bandIndex]!.lowerEdgeHz).toBeCloseTo(thirdOctaveBands[bandIndex - 1]!.upperEdgeHz, 9);
    }
  });

  it('octavas completas: el ancho de cada banda es una octava (relación 10^0,3 ≈ 2)', () => {
    const octaveBands = createFractionalOctaveBands(1, 31, 16_000);
    expect(octaveBands[0]!.centerHz).toBeCloseTo(31.62, 1);
    for (const band of octaveBands) expect(band.upperEdgeHz / band.lowerEdgeHz).toBeCloseTo(10 ** 0.3, 9);
  });

  it('rechaza parámetros no válidos', () => {
    expect(() => createFractionalOctaveBands(0, 100, 1000)).toThrow(RangeError);
    expect(() => createFractionalOctaveBands(3, 0, 1000)).toThrow(RangeError);
    expect(() => createFractionalOctaveBands(3, 1000, 100)).toThrow(RangeError);
  });
});

describe('bandPowersFromAmplitudeSpectrum', () => {
  it('una senoidal de amplitud A pone A²/2 en su banda y nada en las demás', () => {
    const sampleRateHz = 1024;
    const fftSize = 1024;
    const amplitudes = new Float64Array(fftSize / 2 + 1);
    amplitudes[100] = 2;
    const bands = createFractionalOctaveBands(3, 50, 400);
    const bandPowers = bandPowersFromAmplitudeSpectrum(amplitudes, sampleRateHz, fftSize, bands);
    const bandWith100Hz = bands.findIndex((band) => band.lowerEdgeHz <= 100 && band.upperEdgeHz > 100);
    expect(bandPowers[bandWith100Hz]).toBeCloseTo(2);
    expect(Array.from(bandPowers).reduce((powerSum, power) => powerSum + power, 0)).toBeCloseTo(2);
  });

  it('las bandas más estrechas que un bin quedan a 0', () => {
    const bands = createFractionalOctaveBands(3, 1, 4);
    const bandPowers = bandPowersFromAmplitudeSpectrum(new Float64Array(9).fill(1), 16, 16, bands);
    expect(bandPowers.some((power) => power === 0)).toBe(true);
  });
});

describe('formatBandCenter', () => {
  it.each([
    [31.62, '31.5'],
    [12_589, '12.5k'],
    [3.98, '4'],
    [1000, '1k'],
    [20_000, '20k'],
  ])('%p Hz → %s', (centerHz, expectedLabel) => {
    expect(formatBandCenter(centerHz)).toBe(expectedLabel);
  });
});

describe('powerToDecibels', () => {
  it('10·log10 con suelo', () => {
    expect(powerToDecibels(100)).toBeCloseTo(20);
    expect(powerToDecibels(0)).toBe(-200);
    expect(powerToDecibels(1e-30, -120)).toBe(-120);
  });
});
