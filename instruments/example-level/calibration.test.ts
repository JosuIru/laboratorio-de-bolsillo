import { applyLevelCalibration, validateLevelCalibration } from './calibration';

describe('calibración del nivel', () => {
  it('resta el desfase medido sobre una superficie plana', () => {
    expect(
      applyLevelCalibration({ tiltXDegrees: 1.5, tiltYDegrees: -0.5 }, { offsetXDegrees: 0.5, offsetYDegrees: -1 }),
    ).toEqual({ tiltXDegrees: 1, tiltYDegrees: 0.5 });
  });

  it('sin calibración no cambia nada', () => {
    expect(applyLevelCalibration({ tiltXDegrees: 2, tiltYDegrees: 3 }, null)).toEqual({ tiltXDegrees: 2, tiltYDegrees: 3 });
  });

  it('rechaza parámetros absurdos o incompletos', () => {
    expect(() => validateLevelCalibration({ offsetXDegrees: 80, offsetYDegrees: 0 })).toThrow();
    expect(() => validateLevelCalibration({ offsetXDegrees: 1 })).toThrow();
    expect(() => validateLevelCalibration(null)).toThrow();
    expect(validateLevelCalibration({ offsetXDegrees: 1, offsetYDegrees: -2, extra: true })).toEqual({
      offsetXDegrees: 1,
      offsetYDegrees: -2,
    });
  });
});
