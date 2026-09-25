import { validateMetalDetectorCalibration } from './calibration';

describe('validateMetalDetectorCalibration', () => {
  it('acepta un offset razonable', () => {
    expect(validateMetalDetectorCalibration({ offsetX: 20, offsetY: -45.5, offsetZ: 130 })).toEqual({
      offsetX: 20,
      offsetY: -45.5,
      offsetZ: 130,
    });
  });

  it('rechaza valores ausentes, no numéricos o disparatados', () => {
    expect(() => validateMetalDetectorCalibration(null)).toThrow();
    expect(() => validateMetalDetectorCalibration({ offsetX: 1, offsetY: 2 })).toThrow();
    expect(() => validateMetalDetectorCalibration({ offsetX: 1, offsetY: '2', offsetZ: 3 })).toThrow();
    expect(() => validateMetalDetectorCalibration({ offsetX: 1, offsetY: 2, offsetZ: 5000 })).toThrow();
  });
});
