import { createFftPlan, fftInPlace } from '@/processing/dsp/fft';
import { createWindow } from '@/processing/dsp/windows';

import { analyserToneCorrectionDecibels, createAudioFrameAnalyzer } from './frameAnalysis';

const fftSize = 4096;
const sampleRateHz = 48_000;

/** Reproduce lo que entrega un AnalyserNode (Blackman, /N, dB) para una señal dada. */
function simulateAnalyserFrame(samples: Float64Array) {
  const blackmanWindow = createWindow('blackman', fftSize);
  const real = Float64Array.from(samples, (sampleValue, sampleIndex) => sampleValue * blackmanWindow.coefficients[sampleIndex]!);
  const imaginary = new Float64Array(fftSize);
  fftInPlace(createFftPlan(fftSize), real, imaginary);
  const decibelSpectrum = new Float32Array(fftSize / 2);
  for (let binIndex = 0; binIndex < fftSize / 2; binIndex++) {
    decibelSpectrum[binIndex] = 20 * Math.log10(Math.hypot(real[binIndex]!, imaginary[binIndex]!) / fftSize + 1e-12);
  }
  return decibelSpectrum;
}

function seededNoise(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

describe('createAudioFrameAnalyzer', () => {
  const analyzeFrame = createAudioFrameAnalyzer(fftSize);

  it('detecta un tono de 1 kHz a −6 dBFS sobre ruido', () => {
    const nextNoise = seededNoise(3);
    const samples = Float64Array.from(
      { length: fftSize },
      (_, sampleIndex) => 0.5 * Math.sin((2 * Math.PI * 1000 * sampleIndex) / sampleRateHz) + 0.001 * nextNoise(),
    );
    const frameAnalysis = analyzeFrame(simulateAnalyserFrame(samples), samples, sampleRateHz);
    expect(frameAnalysis.dominantFrequencyHz).not.toBeNull();
    expect(Math.abs(frameAnalysis.dominantFrequencyHz! - 1000)).toBeLessThan(sampleRateHz / fftSize / 2);
    expect(frameAnalysis.levelDecibelsFullScale).toBeCloseTo(-6.02, 1);
    // El tono cae entre bins: la ventana de Blackman pierde como mucho ~1,1 dB (scalloping).
    expect(frameAnalysis.dominantToneDecibelsFullScale!).toBeGreaterThan(-6.02 - 1.2);
    expect(frameAnalysis.dominantToneDecibelsFullScale!).toBeLessThan(-6.02 + 0.2);
  });

  it('con solo ruido no inventa una frecuencia dominante', () => {
    const nextNoise = seededNoise(11);
    const samples = Float64Array.from({ length: fftSize }, () => 0.2 * nextNoise());
    const frameAnalysis = analyzeFrame(simulateAnalyserFrame(samples), samples, sampleRateHz);
    expect(frameAnalysis.dominantFrequencyHz).toBeNull();
    expect(frameAnalysis.dominantToneDecibelsFullScale).toBeNull();
    expect(frameAnalysis.levelDecibelsFullScale).toBeLessThan(-10);
  });

  it('tolera −Infinity en el espectro (silencio digital)', () => {
    const silentSpectrum = new Float32Array(fftSize / 2).fill(-Infinity);
    const frameAnalysis = analyzeFrame(silentSpectrum, new Float32Array(fftSize), sampleRateHz);
    expect(frameAnalysis).toEqual({ levelDecibelsFullScale: -160, dominantFrequencyHz: null, dominantToneDecibelsFullScale: null });
  });

  it('la corrección de tono es 20·log10(2/0,42)', () => {
    expect(analyserToneCorrectionDecibels).toBeCloseTo(13.5556, 4);
  });
});
