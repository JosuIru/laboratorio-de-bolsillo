import { computeDecibelOffset, validateSoundLevelCalibration } from './calibration';

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
});
