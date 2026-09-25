import { amplitudeToDecibels, rootMeanSquare } from './levels';
import { biquadGainAt, createBiquadState, designBiquad, processBiquadBlock } from './biquad';

const sampleRateHz = 100;

function filteredSine(kind: 'low-pass' | 'high-pass' | 'band-pass', cutoffHz: number, sineFrequencyHz: number) {
  const coefficients = designBiquad(kind, cutoffHz, sampleRateHz);
  const sampleCount = 4000;
  const samples = Float64Array.from({ length: sampleCount }, (_, sampleIndex) =>
    Math.sin((2 * Math.PI * sineFrequencyHz * sampleIndex) / sampleRateHz),
  );
  processBiquadBlock(coefficients, createBiquadState(), samples, samples);
  // Se descarta el transitorio inicial.
  return rootMeanSquare(samples, 1000) * Math.SQRT2;
}

describe('designBiquad', () => {
  it('Butterworth: −3 dB exactos en la frecuencia de corte', () => {
    for (const kind of ['low-pass', 'high-pass'] as const) {
      const coefficients = designBiquad(kind, 10, sampleRateHz);
      expect(amplitudeToDecibels(biquadGainAt(coefficients, 10, sampleRateHz))).toBeCloseTo(-3.0103, 3);
    }
  });

  it('paso bajo: deja pasar lo lento y atenúa lo rápido (−12 dB/octava)', () => {
    expect(filteredSine('low-pass', 5, 0.5)).toBeCloseTo(1, 2);
    expect(filteredSine('low-pass', 5, 40)).toBeLessThan(0.03);
  });

  it('paso alto: elimina la gravedad (continua) y deja pasar la vibración', () => {
    const coefficients = designBiquad('high-pass', 0.5, sampleRateHz);
    const constantGravity = new Float64Array(2000).fill(9.81);
    processBiquadBlock(coefficients, createBiquadState(), constantGravity, constantGravity);
    expect(Math.abs(constantGravity[1999]!)).toBeLessThan(1e-3);
    expect(filteredSine('high-pass', 0.5, 10)).toBeCloseTo(1, 2);
  });

  it('paso banda: ganancia 1 en el centro', () => {
    expect(biquadGainAt(designBiquad('band-pass', 12, sampleRateHz, 2), 12, sampleRateHz)).toBeCloseTo(1, 6);
  });

  it('rechaza cortes fuera de rango', () => {
    expect(() => designBiquad('low-pass', 0, sampleRateHz)).toThrow(RangeError);
    expect(() => designBiquad('low-pass', 50, sampleRateHz)).toThrow(RangeError);
    expect(() => designBiquad('low-pass', 10, sampleRateHz, 0)).toThrow(RangeError);
  });
});
