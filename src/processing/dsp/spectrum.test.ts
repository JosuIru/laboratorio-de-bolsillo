import { createFftPlan } from './fft';
import { amplitudeToDecibels, rmsToDecibelsFullScale, rootMeanSquare } from './levels';
import {
  binFrequencyHz,
  computeAmplitudeSpectrum,
  createSpectrumWorkspace,
  findDominantFrequency,
  frequencyToBin,
} from './spectrum';
import { createWindow } from './windows';

function sineWave(frequencyHz: number, amplitude: number, sampleRateHz: number, sampleCount: number, offset = 0) {
  return Float64Array.from(
    { length: sampleCount },
    (_, sampleIndex) => offset + amplitude * Math.sin((2 * Math.PI * frequencyHz * sampleIndex) / sampleRateHz),
  );
}

describe('computeAmplitudeSpectrum', () => {
  const fftSize = 1024;
  const sampleRateHz = 1024;
  const plan = createFftPlan(fftSize);
  const workspace = createSpectrumWorkspace(fftSize);

  it.each(['rectangular', 'hann', 'blackman'] as const)(
    'recupera la amplitud de una senoidal en un bin exacto (ventana %s)',
    (windowKind) => {
      const analysisWindow = createWindow(windowKind, fftSize);
      const magnitudes = computeAmplitudeSpectrum(
        plan,
        sineWave(100, 0.8, sampleRateHz, fftSize),
        analysisWindow.coefficients,
        analysisWindow.coherentGain,
        workspace,
      );
      expect(magnitudes).toHaveLength(fftSize / 2 + 1);
      expect(magnitudes[100]).toBeCloseTo(0.8, 6);
    },
  );

  it('quita la componente continua por defecto', () => {
    const analysisWindow = createWindow('hann', fftSize);
    const magnitudes = computeAmplitudeSpectrum(
      plan,
      sineWave(50, 1, sampleRateHz, fftSize, 9.81),
      analysisWindow.coefficients,
      analysisWindow.coherentGain,
      workspace,
    );
    expect(magnitudes[0]).toBeLessThan(1e-9);
    expect(magnitudes[50]).toBeCloseTo(1, 6);
  });
});

describe('findDominantFrequency', () => {
  const fftSize = 4096;
  const sampleRateHz = 48_000;
  const plan = createFftPlan(fftSize);
  const workspace = createSpectrumWorkspace(fftSize);
  const hannWindow = createWindow('hann', fftSize);

  it('encuentra 440 Hz con más precisión que la resolución de la FFT', () => {
    const binResolutionHz = sampleRateHz / fftSize;
    const magnitudes = computeAmplitudeSpectrum(
      plan,
      sineWave(440, 0.5, sampleRateHz, fftSize),
      hannWindow.coefficients,
      hannWindow.coherentGain,
      workspace,
    );
    const dominantFrequency = findDominantFrequency(magnitudes, sampleRateHz, fftSize);
    expect(binResolutionHz).toBeGreaterThan(11);
    expect(Math.abs(dominantFrequency!.frequencyHz - 440)).toBeLessThan(binResolutionHz / 4);
  });

  it('respeta el rango de búsqueda', () => {
    const mixedSignal = sineWave(100, 1, sampleRateHz, fftSize).map(
      (sampleValue, sampleIndex) => sampleValue + 0.2 * Math.sin((2 * Math.PI * 3000 * sampleIndex) / sampleRateHz),
    );
    const magnitudes = computeAmplitudeSpectrum(plan, mixedSignal, hannWindow.coefficients, hannWindow.coherentGain, workspace);
    const dominantAbove1Khz = findDominantFrequency(magnitudes, sampleRateHz, fftSize, 1000);
    expect(dominantAbove1Khz!.frequencyHz).toBeCloseTo(3000, -1);
  });

  it('devuelve null si no hay energía', () => {
    expect(findDominantFrequency(new Float64Array(2049), sampleRateHz, fftSize)).toBeNull();
  });
});

describe('conversión entre bins y frecuencias', () => {
  it('ida y vuelta', () => {
    expect(binFrequencyHz(10, 48_000, 4096)).toBeCloseTo(117.1875);
    expect(frequencyToBin(117.1875, 48_000, 4096)).toBe(10);
    expect(frequencyToBin(1e9, 48_000, 4096)).toBe(2048);
    expect(frequencyToBin(-5, 48_000, 4096)).toBe(0);
  });
});

describe('niveles', () => {
  it('RMS de una senoidal es A/√2 y su dBFS (AES17) es 20·log10(A)', () => {
    const halfScaleSine = sineWave(1000, 0.5, 48_000, 48_000);
    expect(rootMeanSquare(halfScaleSine)).toBeCloseTo(0.5 / Math.SQRT2, 6);
    expect(rmsToDecibelsFullScale(rootMeanSquare(halfScaleSine))).toBeCloseTo(-6.0206, 3);
  });

  it('el silencio no da −∞', () => {
    expect(amplitudeToDecibels(0)).toBe(-160);
    expect(rmsToDecibelsFullScale(rootMeanSquare(new Float64Array(16)))).toBe(-160);
  });
});
