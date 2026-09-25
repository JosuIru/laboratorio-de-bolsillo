import { createFftPlan } from '@/processing/dsp/fft';
import { createSeededRandom } from '@/processing/dsp/signalGenerator';
import { computeAmplitudeSpectrum, createSpectrumWorkspace } from '@/processing/dsp/spectrum';
import { createWindow } from '@/processing/dsp/windows';

import { createGestureClassifier, dopplerShiftToVelocityMetersPerSecond, estimateDopplerShift } from './doppler';

const sampleRateHz = 48000;
const fftSize = 8192;
const carrierFrequencyHz = 20000;

/** Espectro de: tono directo + eco (desplazado) de una mano + ruido. */
function spectrumOf(echoFrequencyHz: number | null, echoAmplitude: number, seed = 1): Float64Array {
  const nextRandom = createSeededRandom(seed);
  const samples = new Float64Array(fftSize);
  for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex++) {
    const timeSeconds = sampleIndex / sampleRateHz;
    samples[sampleIndex] =
      0.5 * Math.sin(2 * Math.PI * carrierFrequencyHz * timeSeconds) +
      (echoFrequencyHz === null ? 0 : echoAmplitude * Math.sin(2 * Math.PI * echoFrequencyHz * timeSeconds)) +
      0.002 * (nextRandom() * 2 - 1);
  }
  const analysisWindow = createWindow('blackman', fftSize);
  return Float64Array.from(
    computeAmplitudeSpectrum(
      createFftPlan(fftSize),
      samples,
      analysisWindow.coefficients,
      analysisWindow.coherentGain,
      createSpectrumWorkspace(fftSize),
    ),
  );
}

const shiftOptions = { sampleRateHz, fftSize, carrierFrequencyHz };

describe('estimateDopplerShift', () => {
  it('encuentra un eco 60 Hz más agudo (mano acercándose)', () => {
    const estimate = estimateDopplerShift(spectrumOf(carrierFrequencyHz + 60, 0.01), shiftOptions);
    expect(estimate.shiftHz).toBeGreaterThan(54);
    expect(estimate.shiftHz).toBeLessThan(66);
    expect(estimate.upperSidebandRelativePower).toBeGreaterThan(estimate.lowerSidebandRelativePower * 10);
    expect(estimate.carrierAmplitude).toBeCloseTo(0.5, 1);
  });

  it('encuentra un eco más grave (mano alejándose)', () => {
    const estimate = estimateDopplerShift(spectrumOf(carrierFrequencyHz - 110, 0.01), shiftOptions);
    expect(estimate.shiftHz).toBeLessThan(-100);
    expect(estimate.shiftHz).toBeGreaterThan(-120);
  });

  it('sin movimiento no hay desplazamiento ni energía lateral apreciable', () => {
    const estimate = estimateDopplerShift(spectrumOf(null, 0, 4), shiftOptions);
    expect(Math.abs(estimate.shiftHz)).toBeLessThan(30);
    expect(estimate.upperSidebandRelativePower + estimate.lowerSidebandRelativePower).toBeLessThan(1e-4);
  });

  it('convierte el desplazamiento en velocidad', () => {
    // Δf = 2·v·f₀/c → v = 58,3 Hz · 343,42 / (2 · 20 000) ≈ 0,5 m/s
    expect(dopplerShiftToVelocityMetersPerSecond(58.3, 20000, 20)).toBeCloseTo(0.5, 2);
    expect(dopplerShiftToVelocityMetersPerSecond(-58.3, 20000, 20)).toBeCloseTo(-0.5, 2);
  });
});

describe('createGestureClassifier', () => {
  it('confirma el gesto tras dos tramas y vuelve a quieto', () => {
    const gestureClassifier = createGestureClassifier();
    expect(gestureClassifier.push(0.4, 0.01)).toBe('still');
    expect(gestureClassifier.push(0.4, 0.01)).toBe('approaching');
    expect(gestureClassifier.push(-0.3, 0.01)).toBe('approaching');
    expect(gestureClassifier.push(-0.3, 0.01)).toBe('receding');
    // Energía lateral insuficiente: no cuenta como movimiento.
    expect(gestureClassifier.push(0.5, 1e-7)).toBe('receding');
    expect(gestureClassifier.push(0.5, 1e-7)).toBe('still');
  });
});
