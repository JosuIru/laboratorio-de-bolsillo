import { createFftPlan } from './fft';
import { estimateFundamentalFrequency } from './fundamentalFrequency';
import { generateNoise, generateTone } from './signalGenerator';
import { computeAmplitudeSpectrum, createSpectrumWorkspace } from './spectrum';
import { createWindow } from './windows';

const sampleRateHz = 16000;
const fftSize = 8192;

/** Suma de armónicos de `fundamentalHz` con las amplitudes dadas, más un poco de ruido. */
function harmonicSpectrum(fundamentalHz: number, harmonicAmplitudes: readonly number[], noiseAmplitude = 0.001) {
  const durationSeconds = fftSize / sampleRateHz;
  const mixedSamples = generateNoise({ sampleRateHz, durationSeconds, amplitude: noiseAmplitude, seed: 4 });
  harmonicAmplitudes.forEach((harmonicAmplitude, harmonicIndex) => {
    const harmonicSamples = generateTone({
      frequencyHz: fundamentalHz * (harmonicIndex + 1),
      sampleRateHz,
      durationSeconds,
      amplitude: harmonicAmplitude,
    });
    harmonicSamples.forEach((sampleValue, sampleIndex) => (mixedSamples[sampleIndex]! += sampleValue));
  });
  const analysisWindow = createWindow('hann', fftSize);
  return Float64Array.from(
    computeAmplitudeSpectrum(
      createFftPlan(fftSize),
      mixedSamples,
      analysisWindow.coefficients,
      analysisWindow.coherentGain,
      createSpectrumWorkspace(fftSize),
    ),
  );
}

const searchOptions = { sampleRateHz, fftSize, minimumFrequencyHz: 10, maximumFrequencyHz: 2000 };
/** La resolución es fs/N ≈ 2 Hz; con interpolación se afina bastante más. */
const frequencyToleranceHz = 0.5;

describe('estimateFundamentalFrequency', () => {
  it('encuentra un tono puro sin irse a la suboctava', () => {
    const fundamentalEstimate = estimateFundamentalFrequency(harmonicSpectrum(440, [0.5]), searchOptions)!;
    expect(Math.abs(fundamentalEstimate.frequencyHz - 440)).toBeLessThan(frequencyToleranceHz);
    expect(fundamentalEstimate.detectedHarmonicCount).toBe(1);
  });

  it('elige la fundamental aunque el segundo armónico suene mucho más fuerte', () => {
    const fundamentalEstimate = estimateFundamentalFrequency(harmonicSpectrum(50, [0.05, 1, 0.6, 0.4, 0.2]), searchOptions)!;
    expect(Math.abs(fundamentalEstimate.frequencyHz - 50)).toBeLessThan(frequencyToleranceHz);
    expect(fundamentalEstimate.detectedHarmonicCount).toBe(5);
  });

  it('afina más allá de la resolución de la FFT', () => {
    const fundamentalEstimate = estimateFundamentalFrequency(harmonicSpectrum(123.4, [0.5, 0.3, 0.2]), searchOptions)!;
    expect(Math.abs(fundamentalEstimate.frequencyHz - 123.4)).toBeLessThan(frequencyToleranceHz);
  });

  it('respeta el rango de búsqueda', () => {
    const spectrum = harmonicSpectrum(50, [1, 0.8, 0.6]);
    const fundamentalEstimate = estimateFundamentalFrequency(spectrum, { ...searchOptions, minimumFrequencyHz: 80 })!;
    expect(fundamentalEstimate.frequencyHz).toBeGreaterThan(80);
  });

  it('devuelve null con solo ruido', () => {
    expect(estimateFundamentalFrequency(harmonicSpectrum(100, [], 0.1), searchOptions)).toBeNull();
  });
});
