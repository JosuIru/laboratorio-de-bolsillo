import { createFftPlan } from './fft';
import { estimateFundamentalFrequency } from './fundamentalFrequency';
import { generateNoise, generateTone } from './signalGenerator';
import { computeAmplitudeSpectrum, createSpectrumWorkspace } from './spectrum';
import { createWindow, type WindowKind } from './windows';

const sampleRateHz = 16000;
const fftSize = 8192;

/** Suma de armónicos de `fundamentalHz` con las amplitudes dadas, más un poco de ruido. */
function harmonicSpectrum(
  fundamentalHz: number,
  harmonicAmplitudes: readonly number[],
  noiseAmplitude = 0.001,
  { spectrumSampleRateHz = sampleRateHz, spectrumFftSize = fftSize, windowKind = 'hann' as WindowKind } = {},
) {
  const sampleRateHz = spectrumSampleRateHz;
  const fftSize = spectrumFftSize;
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
  const analysisWindow = createWindow(windowKind, fftSize);
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

  describe('con los ajustes del tacómetro (48 kHz, FFT de 16384, ventana Blackman del AnalyserNode)', () => {
    const tachometerSpectrumOptions = { spectrumSampleRateHz: 48000, spectrumFftSize: 16384, windowKind: 'blackman' as const };
    const tachometerSearchOptions = { sampleRateHz: 48000, fftSize: 16384, minimumFrequencyHz: 5, maximumFrequencyHz: 2000 };
    const lowFundamentalsHz = [12.3, 23.7, 37.1, 48.9];

    it.each(lowFundamentalsHz)('con armónicos, %s Hz sale con menos del 0,1 %% de error', (fundamentalHz) => {
      const fundamentalEstimate = estimateFundamentalFrequency(
        harmonicSpectrum(fundamentalHz, [0.5, 0.3, 0.2, 0.15], 0.001, tachometerSpectrumOptions),
        tachometerSearchOptions,
      )!;
      const frequencyErrorHz = Math.abs(fundamentalEstimate.frequencyHz - fundamentalHz);
      expect(frequencyErrorHz / fundamentalHz).toBeLessThan(0.001);
      // La incertidumbre declarada cubre el error real y es menor que con un solo pico.
      expect(frequencyErrorHz).toBeLessThan(2 * fundamentalEstimate.frequencyUncertaintyHz);
      expect(fundamentalEstimate.frequencyUncertaintyHz).toBeLessThan(0.05);
    });

    it.each(lowFundamentalsHz)('un tono puro de %s Hz no cae a una suboctava por los lóbulos de la ventana', (fundamentalHz) => {
      const fundamentalEstimate = estimateFundamentalFrequency(
        harmonicSpectrum(fundamentalHz, [0.5], 0.001, tachometerSpectrumOptions),
        tachometerSearchOptions,
      )!;
      const frequencyErrorHz = Math.abs(fundamentalEstimate.frequencyHz - fundamentalHz);
      expect(frequencyErrorHz / fundamentalHz).toBeLessThan(0.005);
      expect(frequencyErrorHz).toBeLessThan(fundamentalEstimate.frequencyUncertaintyHz);
    });

    it('los armónicos afinan: la incertidumbre baja al detectar más', () => {
      const pureToneEstimate = estimateFundamentalFrequency(
        harmonicSpectrum(30, [0.5], 0.001, tachometerSpectrumOptions),
        tachometerSearchOptions,
      )!;
      const harmonicEstimate = estimateFundamentalFrequency(
        harmonicSpectrum(30, [0.5, 0.4, 0.3], 0.001, tachometerSpectrumOptions),
        tachometerSearchOptions,
      )!;
      expect(harmonicEstimate.frequencyUncertaintyHz).toBeLessThan(pureToneEstimate.frequencyUncertaintyHz / 2);
    });
  });
});
