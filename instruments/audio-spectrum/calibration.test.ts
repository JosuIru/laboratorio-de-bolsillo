import { computeDecibelOffset, parseDecimalInput, validateSoundLevelCalibration } from './calibration';

describe('calibración de nivel sonoro', () => {
  it('el desplazamiento es referencia − medida', () => {
    expect(computeDecibelOffset(65, -38.5)).toBe(103.5);
  });

  it('acepta desplazamientos plausibles y rechaza el resto', () => {
    expect(validateSoundLevelCalibration({ decibelOffset: 103.5 })).toEqual({ decibelOffset: 103.5 });
    expect(() => validateSoundLevelCalibration({ decibelOffset: 20 })).toThrow();
    expect(() => validateSoundLevelCalibration({ decibelOffset: Number.NaN })).toThrow();
    expect(() => validateSoundLevelCalibration(null)).toThrow();
  });

  it.each([
    ['65', 65],
    ['65,5', 65.5],
    [' 72.25 ', 72.25],
    ['abc', null],
    ['', null],
    ['6,5,1', null],
  ])('parseDecimalInput(%j) → %p', (inputText, expectedNumber) => {
    expect(parseDecimalInput(inputText)).toBe(expectedNumber);
  });
});
