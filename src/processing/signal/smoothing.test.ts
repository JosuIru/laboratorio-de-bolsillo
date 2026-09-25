import { createExponentialSmoother, mean, smoothingFactorForTimeConstant } from './smoothing';

describe('createExponentialSmoother', () => {
  it('devuelve la primera muestra tal cual y luego se acerca a la entrada', () => {
    const smoother = createExponentialSmoother(0.5);
    expect(smoother.push(10)).toBe(10);
    expect(smoother.push(20)).toBe(15);
    expect(smoother.push(20)).toBe(17.5);
  });

  it('converge a una entrada constante', () => {
    const smoother = createExponentialSmoother(0.1);
    smoother.push(0);
    let smoothedValue = 0;
    for (let sampleIndex = 0; sampleIndex < 200; sampleIndex++) smoothedValue = smoother.push(1);
    expect(smoothedValue).toBeCloseTo(1, 6);
  });

  it('reset olvida el estado', () => {
    const smoother = createExponentialSmoother(0.1);
    smoother.push(100);
    smoother.reset();
    expect(smoother.push(3)).toBe(3);
  });

  it.each([0, -0.1, 1.5, NaN])('rechaza el factor %p', (invalidFactor) => {
    expect(() => createExponentialSmoother(invalidFactor)).toThrow(RangeError);
  });
});

describe('smoothingFactorForTimeConstant', () => {
  it('coincide con la fórmula del filtro RC discreto', () => {
    expect(smoothingFactorForTimeConstant(0.2, 50)).toBeCloseTo(0.02 / 0.22);
  });
});

describe('mean', () => {
  it('calcula la media y devuelve NaN si no hay datos', () => {
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(mean([])).toBeNaN();
  });
});
