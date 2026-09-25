import { createExposureScale, formatExposureValue, stepExposure } from './exposureScale';

describe('escala de exposición', () => {
  it('en Android usa pasos enteros y empieza en el mínimo', () => {
    const stepScale = createExposureScale(-24, 24, true);
    expect(stepScale.initialValue).toBe(-24);
    expect(stepScale.increment).toBe(3);
    expect(stepExposure(stepScale, -24, 1)).toBe(-21);
    expect(stepExposure(stepScale, -23, -1)).toBe(-24);
    expect(stepExposure(stepScale, 23, 1)).toBe(24);
  });

  it('con rangos pequeños avanza de paso en paso', () => {
    expect(createExposureScale(-6, 6, true).increment).toBe(1);
  });

  it('en EV empieza en -2 sin pasar del mínimo del móvil', () => {
    expect(createExposureScale(-8, 8, false).initialValue).toBe(-2);
    expect(createExposureScale(-1, 1, false).initialValue).toBe(-1);
    expect(stepExposure(createExposureScale(-8, 8, false), -2, 1)).toBe(-1.5);
  });

  it('formatea con signo', () => {
    const stepScale = createExposureScale(-24, 24, true);
    expect(formatExposureValue(stepScale, -12)).toBe('−12');
    expect(formatExposureValue(stepScale, 3)).toBe('+3');
    expect(formatExposureValue(stepScale, 0)).toBe('0');
    expect(formatExposureValue(createExposureScale(-8, 8, false), -1.5)).toBe('−1.5');
  });
});
