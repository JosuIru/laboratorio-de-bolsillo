import { computeAmplitudeSpectrum, createSpectrumWorkspace, findDominantFrequency } from '@/processing/dsp/spectrum';
import { createFftPlan } from '@/processing/dsp/fft';
import { createWindow } from '@/processing/dsp/windows';

import { chooseSonarBand, createPulsePeriod, evaluateSonarChirpAt, generateSonarChirp } from './chirp';

const sampleRateHz = 48000;
const chirpSpecification = { startFrequencyHz: 18000, endFrequencyHz: 22000, durationSeconds: 0.008 };

function dominantFrequencyInWindow(samples: Float32Array, startIndex: number, fftSize: number): number {
  const analysisWindow = createWindow('hann', fftSize);
  const magnitudes = computeAmplitudeSpectrum(
    createFftPlan(fftSize),
    samples.subarray(startIndex, startIndex + fftSize),
    analysisWindow.coefficients,
    analysisWindow.coherentGain,
    createSpectrumWorkspace(fftSize),
  );
  return findDominantFrequency(magnitudes, sampleRateHz, fftSize)!.frequencyHz;
}

describe('generateSonarChirp', () => {
  const chirpSamples = generateSonarChirp(chirpSpecification, sampleRateHz);

  it('dura lo pedido y empieza y acaba en silencio (sin clic)', () => {
    expect(chirpSamples).toHaveLength(384);
    expect(Math.abs(chirpSamples[0]!)).toBeLessThan(1e-6);
    expect(Math.abs(chirpSamples[chirpSamples.length - 1]!)).toBeLessThan(0.01);
    let peakAbsolute = 0;
    for (const chirpValue of chirpSamples) peakAbsolute = Math.max(peakAbsolute, Math.abs(chirpValue));
    expect(peakAbsolute).toBeGreaterThan(0.95);
    expect(peakAbsolute).toBeLessThanOrEqual(1);
  });

  it('barre linealmente de la frecuencia inicial a la final', () => {
    const earlyFrequencyHz = dominantFrequencyInWindow(chirpSamples, 64, 64);
    const lateFrequencyHz = dominantFrequencyInWindow(chirpSamples, 256, 64);
    // Centro de cada ventana: 96 y 288 muestras → 19 000 y 21 000 Hz.
    expect(earlyFrequencyHz).toBeGreaterThan(18300);
    expect(earlyFrequencyHz).toBeLessThan(19700);
    expect(lateFrequencyHz).toBeGreaterThan(20300);
    expect(lateFrequencyHz).toBeLessThan(21700);
  });

  it('vale 0 fuera del pulso', () => {
    expect(evaluateSonarChirpAt(chirpSpecification, -0.001)).toBe(0);
    expect(evaluateSonarChirpAt(chirpSpecification, 0.01)).toBe(0);
  });

  it('rechaza bandas por encima de Nyquist', () => {
    expect(() => generateSonarChirp(chirpSpecification, 32000)).toThrow(RangeError);
  });

  it('coloca el chirp al principio de un periodo de silencio', () => {
    const periodSamples = createPulsePeriod(chirpSamples, 7200);
    expect(periodSamples).toHaveLength(7200);
    expect(periodSamples[100]).toBe(chirpSamples[100]);
    expect(periodSamples[5000]).toBe(0);
    expect(() => createPulsePeriod(chirpSamples, 100)).toThrow(RangeError);
  });
});

describe('chooseSonarBand', () => {
  it('a 48 kHz usa la banda pedida', () => {
    expect(chooseSonarBand(48000)).toEqual({
      lowFrequencyHz: 18000,
      highFrequencyHz: 22000,
      isReduced: false,
      isLikelyAudible: false,
    });
  });

  it('con menos muestreo baja la banda manteniendo el ancho y avisa si será audible', () => {
    const bandAt44100 = chooseSonarBand(44100);
    expect(bandAt44100.highFrequencyHz).toBeCloseTo(21050);
    expect(bandAt44100.highFrequencyHz - bandAt44100.lowFrequencyHz).toBeCloseTo(4000);
    expect(bandAt44100.isReduced).toBe(true);
    const bandAt32000 = chooseSonarBand(32000);
    expect(bandAt32000).toEqual({
      lowFrequencyHz: 11000,
      highFrequencyHz: 15000,
      isReduced: true,
      isLikelyAudible: true,
    });
  });
});
