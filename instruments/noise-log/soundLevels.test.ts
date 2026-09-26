import { createFftPlan, fftInPlace } from '@/processing/dsp/fft';
import { createWindow } from '@/processing/dsp/windows';

import {
  aWeightingDecibels,
  createSpectrumLevelMeter,
  energeticSumDecibels,
  equivalentContinuousLevel,
  minimumLevelDecibels,
  percentileExceededLevel,
} from './soundLevels';

/** Imita getFloatFrequencyData del AnalyserNode: Blackman, FFT, ÷N y 20·log10. */
function simulateAnalyserSpectrum(samples: Float64Array): Float64Array {
  const fftSize = samples.length;
  const blackmanWindow = createWindow('blackman', fftSize).coefficients;
  const realPart = Float64Array.from(samples, (sampleValue, sampleIndex) => sampleValue * blackmanWindow[sampleIndex]!);
  const imaginaryPart = new Float64Array(fftSize);
  fftInPlace(createFftPlan(fftSize), realPart, imaginaryPart);
  return Float64Array.from({ length: fftSize / 2 }, (_, binIndex) =>
    20 * Math.log10(Math.hypot(realPart[binIndex]!, imaginaryPart[binIndex]!) / fftSize),
  );
}

function sineSamples(fftSize: number, frequencyHz: number, amplitude: number, sampleRateHz: number): Float64Array {
  return Float64Array.from({ length: fftSize }, (_, sampleIndex) =>
    amplitude * Math.sin((2 * Math.PI * frequencyHz * sampleIndex) / sampleRateHz),
  );
}

describe('suma y media energética', () => {
  it('dos fuentes iguales suman 3 dB, no el doble', () => {
    expect(energeticSumDecibels([60, 60])).toBeCloseTo(63.01, 2);
    expect(energeticSumDecibels([70, 50])).toBeCloseTo(70.04, 2);
  });

  it('el Leq es media energética, no aritmética', () => {
    // Medio tiempo a 70 dB y medio a 40 dB: 67 dB, no 55.
    expect(equivalentContinuousLevel([70, 40])).toBeCloseTo(67.0, 1);
    expect(equivalentContinuousLevel([55, 55, 55])).toBeCloseTo(55, 9);
    expect(equivalentContinuousLevel([])).toBeNull();
  });

  it('no devuelve −∞ con silencio absoluto', () => {
    expect(energeticSumDecibels([])).toBe(minimumLevelDecibels);
  });
});

describe('percentileExceededLevel', () => {
  const levelsOneToHundred = Array.from({ length: 101 }, (_, levelIndex) => levelIndex);

  it('L10 es el nivel superado el 10 % del tiempo y L90 el 90 %', () => {
    expect(percentileExceededLevel(levelsOneToHundred, 10)).toBeCloseTo(90, 9);
    expect(percentileExceededLevel(levelsOneToHundred, 90)).toBeCloseTo(10, 9);
    expect(percentileExceededLevel(levelsOneToHundred.slice().reverse(), 50)).toBeCloseTo(50, 9);
  });

  it('interpola y admite una sola muestra', () => {
    expect(percentileExceededLevel([40, 50], 50)).toBeCloseTo(45, 9);
    expect(percentileExceededLevel([42], 10)).toBe(42);
    expect(percentileExceededLevel([], 10)).toBeNull();
  });
});

describe('aWeightingDecibels', () => {
  it('coincide con la tabla de IEC 61672-1 (frecuencias nominales, de ahí el margen)', () => {
    const referenceWeightings: [number, number][] = [
      [31.5, -39.4],
      [63, -26.2],
      [100, -19.1],
      [250, -8.6],
      [500, -3.2],
      [1000, 0],
      [2000, 1.2],
      [4000, 1.0],
      [8000, -1.1],
      [16000, -6.6],
    ];
    expect(aWeightingDecibels(1000)).toBeCloseTo(0, 2);
    for (const [frequencyHz, expectedDecibels] of referenceWeightings) {
      expect(Math.abs(aWeightingDecibels(frequencyHz) - expectedDecibels)).toBeLessThan(0.15);
    }
  });
});

describe('createSpectrumLevelMeter', () => {
  const fftSize = 8192;
  const sampleRateHz = 48_000;
  const measureSpectrumLevels = createSpectrumLevelMeter(fftSize, sampleRateHz);

  it('una senoidal de amplitud 0,5 a 1 kHz da −6 dBFS con y sin ponderar (como el nivel RMS)', () => {
    const levels = measureSpectrumLevels(simulateAnalyserSpectrum(sineSamples(fftSize, 1000, 0.5, sampleRateHz)));
    expect(levels.unweightedDecibelsFullScale).toBeCloseTo(-6.02, 1);
    expect(levels.aWeightedDecibelsFullScale).toBeCloseTo(-6.02, 1);
  });

  it('a 100 Hz la ponderación A resta unos 19 dB', () => {
    const levels = measureSpectrumLevels(simulateAnalyserSpectrum(sineSamples(fftSize, 100, 0.5, sampleRateHz)));
    expect(levels.unweightedDecibelsFullScale).toBeCloseTo(-6.02, 1);
    expect(levels.aWeightedDecibelsFullScale - levels.unweightedDecibelsFullScale).toBeCloseTo(-19.1, 0);
  });

  it('con ruido blanco coincide con el nivel RMS de la señal', () => {
    let pseudoRandomState = 12345;
    const noiseSamples = Float64Array.from({ length: fftSize }, () => {
      pseudoRandomState = (pseudoRandomState * 1103515245 + 12345) % 2 ** 31;
      return (pseudoRandomState / 2 ** 31 - 0.5) * 0.2;
    });
    const meanSquare = noiseSamples.reduce((squaredSum, sampleValue) => squaredSum + sampleValue * sampleValue, 0) / fftSize;
    const rmsDecibelsFullScale = 10 * Math.log10(2 * meanSquare);
    const levels = measureSpectrumLevels(simulateAnalyserSpectrum(noiseSamples));
    expect(levels.unweightedDecibelsFullScale).toBeCloseTo(rmsDecibelsFullScale, 0);
  });

  it('ignora bins −∞ (silencio digital)', () => {
    const levels = measureSpectrumLevels(new Float64Array(fftSize / 2).fill(-Infinity));
    expect(levels.aWeightedDecibelsFullScale).toBe(minimumLevelDecibels);
  });
});
