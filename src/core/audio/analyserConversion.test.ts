import { analyserDecibelsToToneAmplitudes } from './useMicrophoneSpectrum';

describe('analyserDecibelsToToneAmplitudes', () => {
  it('invierte la escala del AnalyserNode (Blackman y 1/N)', () => {
    // Senoidal de amplitud 0,5: el AnalyserNode da 20·log10(0,5 · 0,42 / 2) dB en su bin.
    const analyserDecibels = 20 * Math.log10((0.5 * 0.42) / 2);
    const amplitudes = analyserDecibelsToToneAmplitudes([analyserDecibels, -Infinity], new Float64Array(2));
    expect(amplitudes[0]).toBeCloseTo(0.5, 9);
    expect(amplitudes[1]).toBe(0);
  });
});
