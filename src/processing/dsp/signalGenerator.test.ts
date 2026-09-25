import { createFftPlan } from './fft';
import { peakAbsolute, rootMeanSquare } from './levels';
import {
  applyFadesInPlace,
  createOscillator,
  createSeededRandom,
  generateNoise,
  generateSweep,
  generateTone,
  sweepFrequencyAt,
  waveformValue,
} from './signalGenerator';
import { computeAmplitudeSpectrum, createSpectrumWorkspace, findDominantFrequency, frequencyToBin } from './spectrum';
import { createWindow } from './windows';

const sampleRateHz = 16000;

function dominantFrequencyOf(samples: Float32Array, startIndex: number, fftSize = 4096): number {
  const plan = createFftPlan(fftSize);
  const analysisWindow = createWindow('hann', fftSize);
  const magnitudes = computeAmplitudeSpectrum(
    plan,
    samples.subarray(startIndex, startIndex + fftSize),
    analysisWindow.coefficients,
    analysisWindow.coherentGain,
    createSpectrumWorkspace(fftSize),
  );
  return findDominantFrequency(magnitudes, sampleRateHz, fftSize)!.frequencyHz;
}

/** Potencia media por banda de frecuencia, promediando varias tramas para quitar varianza. */
function bandPower(samples: Float32Array, lowFrequencyHz: number, highFrequencyHz: number, fftSize = 1024): number {
  const plan = createFftPlan(fftSize);
  const analysisWindow = createWindow('hann', fftSize);
  const workspace = createSpectrumWorkspace(fftSize);
  const lowBin = frequencyToBin(lowFrequencyHz, sampleRateHz, fftSize);
  const highBin = frequencyToBin(highFrequencyHz, sampleRateHz, fftSize);
  let accumulatedPower = 0;
  let frameCount = 0;
  for (let frameStart = 0; frameStart + fftSize <= samples.length; frameStart += fftSize) {
    const magnitudes = computeAmplitudeSpectrum(
      plan,
      samples.subarray(frameStart, frameStart + fftSize),
      analysisWindow.coefficients,
      analysisWindow.coherentGain,
      workspace,
    );
    for (let binIndex = lowBin; binIndex < highBin; binIndex++) accumulatedPower += magnitudes[binIndex]! ** 2;
    frameCount++;
  }
  return accumulatedPower / frameCount;
}

describe('waveformValue', () => {
  it('todas las formas empiezan en 0 o en su máximo y tienen pico 1', () => {
    expect(waveformValue('sine', 0.25)).toBeCloseTo(1, 12);
    expect(waveformValue('triangle', 0)).toBe(0);
    expect(waveformValue('triangle', 0.25)).toBe(1);
    expect(waveformValue('triangle', 0.75)).toBe(-1);
    expect(waveformValue('sawtooth', 0)).toBe(0);
    expect(waveformValue('sawtooth', 0.75)).toBe(-0.5);
    expect(waveformValue('square', 0.2)).toBe(1);
    expect(waveformValue('square', 0.7)).toBe(-1);
  });
});

describe('generateTone', () => {
  it('genera la frecuencia, la duración y la amplitud pedidas', () => {
    const toneSamples = generateTone({ frequencyHz: 1000, sampleRateHz, durationSeconds: 0.5, amplitude: 0.5 });
    expect(toneSamples).toHaveLength(8000);
    expect(peakAbsolute(toneSamples)).toBeCloseTo(0.5, 5);
    expect(rootMeanSquare(toneSamples)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(dominantFrequencyOf(toneSamples, 0)).toBeCloseTo(1000, 0);
  });

  it('una cuadrada tiene valor eficaz igual a su amplitud', () => {
    const squareSamples = generateTone({ frequencyHz: 250, sampleRateHz, durationSeconds: 0.2, waveform: 'square' });
    expect(rootMeanSquare(squareSamples)).toBeCloseTo(1, 6);
  });

  it('rechaza frecuencias por encima de Nyquist', () => {
    expect(() => generateTone({ frequencyHz: 9000, sampleRateHz, durationSeconds: 0.1 })).toThrow(RangeError);
  });
});

describe('createOscillator', () => {
  it('generar por bloques da la misma señal que de una vez (sin saltos de fase)', () => {
    const oscillator = createOscillator(sampleRateHz, 440, 'triangle');
    const firstBlock = oscillator.fill(new Float32Array(100));
    const secondBlock = oscillator.fill(new Float32Array(100));
    const continuousSamples = generateTone({ frequencyHz: 440, sampleRateHz, durationSeconds: 200 / sampleRateHz, waveform: 'triangle' });
    const blockSamples = new Float32Array([...firstBlock, ...secondBlock]);
    blockSamples.forEach((sampleValue, sampleIndex) => expect(sampleValue).toBeCloseTo(continuousSamples[sampleIndex]!, 5));
  });

  it('cambiar de frecuencia no produce saltos mayores que el paso normal', () => {
    const oscillator = createOscillator(sampleRateHz, 200);
    const firstBlock = oscillator.fill(new Float32Array(37));
    oscillator.setFrequency(400);
    const secondBlock = oscillator.fill(new Float32Array(10));
    const maximumStepAt400Hz = 2 * Math.PI * (400 / sampleRateHz);
    expect(Math.abs(secondBlock[0]! - firstBlock[36]!)).toBeLessThanOrEqual(maximumStepAt400Hz + 1e-6);
  });
});

describe('createSeededRandom', () => {
  it('es reproducible con la misma semilla y distinta con otra', () => {
    const firstGenerator = createSeededRandom(42);
    const secondGenerator = createSeededRandom(42);
    const thirdGenerator = createSeededRandom(43);
    const firstSequence = Array.from({ length: 5 }, () => firstGenerator());
    expect(Array.from({ length: 5 }, () => secondGenerator())).toEqual(firstSequence);
    expect(Array.from({ length: 5 }, () => thirdGenerator())).not.toEqual(firstSequence);
  });

  it('reparte los valores de forma uniforme en [0, 1)', () => {
    const nextRandom = createSeededRandom(7);
    const randomValues = Array.from({ length: 20000 }, () => nextRandom());
    expect(Math.min(...randomValues)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...randomValues)).toBeLessThan(1);
    const valueMean = randomValues.reduce((valueSum, value) => valueSum + value, 0) / randomValues.length;
    expect(valueMean).toBeCloseTo(0.5, 1);
  });
});

describe('generateNoise', () => {
  const noiseDurationSeconds = 4;

  it('normaliza el pico a la amplitud pedida y es reproducible', () => {
    const firstNoise = generateNoise({ sampleRateHz, durationSeconds: 0.1, amplitude: 0.8, seed: 5 });
    expect(peakAbsolute(firstNoise)).toBeCloseTo(0.8, 5);
    expect(generateNoise({ sampleRateHz, durationSeconds: 0.1, amplitude: 0.8, seed: 5 })).toEqual(firstNoise);
  });

  it('el ruido blanco tiene la misma energía por hercio: una octava más arriba, el doble', () => {
    const whiteNoise = generateNoise({ sampleRateHz, durationSeconds: noiseDurationSeconds });
    const powerRatio = bandPower(whiteNoise, 2000, 4000) / bandPower(whiteNoise, 1000, 2000);
    expect(powerRatio).toBeGreaterThan(1.8);
    expect(powerRatio).toBeLessThan(2.2);
  });

  it('el ruido rosa tiene la misma energía por octava', () => {
    const pinkNoise = generateNoise({ sampleRateHz, durationSeconds: noiseDurationSeconds, color: 'pink' });
    const powerRatio = bandPower(pinkNoise, 2000, 4000) / bandPower(pinkNoise, 250, 500);
    expect(powerRatio).toBeGreaterThan(0.8);
    expect(powerRatio).toBeLessThan(1.25);
  });
});

describe('generateSweep', () => {
  const sweepOptions = { startFrequencyHz: 100, endFrequencyHz: 6400, durationSeconds: 2 };

  it('el barrido logarítmico pasa por cada octava en el mismo tiempo', () => {
    // 100 → 6400 Hz son 6 octavas en 2 s: a mitad de camino (1 s) va por 800 Hz.
    expect(sweepFrequencyAt(sweepOptions, 1)).toBeCloseTo(800, 6);
    const sweepSamples = generateSweep({ ...sweepOptions, sampleRateHz });
    const analysisSize = 1024;
    const centeredStart = sampleRateHz * 1 - analysisSize / 2;
    expect(dominantFrequencyOf(sweepSamples, centeredStart, analysisSize)).toBeGreaterThan(760);
    expect(dominantFrequencyOf(sweepSamples, centeredStart, analysisSize)).toBeLessThan(840);
  });

  it('el barrido lineal avanza los mismos hercios por segundo', () => {
    const linearOptions = { ...sweepOptions, kind: 'linear' as const };
    expect(sweepFrequencyAt(linearOptions, 1)).toBeCloseTo(3250, 6);
    const sweepSamples = generateSweep({ ...linearOptions, sampleRateHz });
    const analysisSize = 512;
    const centeredStart = sampleRateHz * 1 - analysisSize / 2;
    expect(Math.abs(dominantFrequencyOf(sweepSamples, centeredStart, analysisSize) - 3250)).toBeLessThan(60);
  });

  it('rechaza frecuencias no positivas o por encima de Nyquist', () => {
    expect(() => generateSweep({ ...sweepOptions, startFrequencyHz: 0, sampleRateHz })).toThrow(RangeError);
    expect(() => generateSweep({ ...sweepOptions, endFrequencyHz: 9000, sampleRateHz })).toThrow(RangeError);
  });
});

describe('applyFadesInPlace', () => {
  it('lleva los extremos a cero y deja intacto el centro', () => {
    const constantSamples = new Float32Array(100).fill(1);
    applyFadesInPlace(constantSamples, 10);
    expect(constantSamples[0]).toBe(0);
    expect(constantSamples[99]).toBe(0);
    expect(constantSamples[5]).toBeCloseTo(0.5, 6);
    expect(constantSamples[50]).toBe(1);
  });

  it('con una señal más corta que las dos rampas, las acorta a la mitad', () => {
    const shortSamples = new Float32Array(6).fill(1);
    applyFadesInPlace(shortSamples, 10);
    expect(shortSamples[0]).toBe(0);
    expect(shortSamples[5]).toBe(0);
    expect(Math.max(...shortSamples)).toBeLessThanOrEqual(1);
  });
});
