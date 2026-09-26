import { resampleWithLowPass } from './audioResampling';

function sineWave(frequencyHz: number, sampleRateHz: number, sampleCount: number): Float32Array {
  const samples = new Float32Array(sampleCount);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    samples[sampleIndex] = Math.sin((2 * Math.PI * frequencyHz * sampleIndex) / sampleRateHz);
  }
  return samples;
}

function rootMeanSquare(samples: ArrayLike<number>, firstIndex: number, lastIndex: number): number {
  let squaredSum = 0;
  for (let sampleIndex = firstIndex; sampleIndex < lastIndex; sampleIndex++) squaredSum += samples[sampleIndex]! ** 2;
  return Math.sqrt(squaredSum / (lastIndex - firstIndex));
}

describe('resampleWithLowPass', () => {
  it('pasa de 48 kHz a 32 kHz conservando un tono de 1 kHz', () => {
    const inputSamples = sineWave(1000, 48000, 4800);
    const outputSamples = resampleWithLowPass(inputSamples, 48000, 32000);
    expect(outputSamples).toHaveLength(3200);
    const expectedSamples = sineWave(1000, 32000, 3200);
    let maximumError = 0;
    // Lejos de los bordes, donde el filtro no tiene audio a un lado.
    for (let sampleIndex = 100; sampleIndex < 3100; sampleIndex++) {
      maximumError = Math.max(maximumError, Math.abs(outputSamples[sampleIndex]! - expectedSamples[sampleIndex]!));
    }
    expect(maximumError).toBeLessThan(0.01);
  });

  it('elimina lo que queda por encima de la nueva frecuencia de Nyquist (antialias)', () => {
    const inputSamples = sineWave(20000, 48000, 9600);
    const outputSamples = resampleWithLowPass(inputSamples, 48000, 32000);
    // Sin filtro, este tono de 20 kHz aparecería como uno de 12 kHz con amplitud casi entera.
    expect(rootMeanSquare(outputSamples, 200, outputSamples.length - 200)).toBeLessThan(0.01);
  });

  it('funciona también desde 44,1 kHz y respeta la longitud pedida', () => {
    const inputSamples = sineWave(2000, 44100, 44100);
    const outputSamples = resampleWithLowPass(inputSamples, 44100, 32000, 32000);
    expect(outputSamples).toHaveLength(32000);
    expect(rootMeanSquare(outputSamples, 1000, 31000)).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('rellena con ceros si falta audio y copia si la frecuencia ya es la buena', () => {
    const paddedSamples = resampleWithLowPass(new Float32Array(10).fill(0.5), 32000, 32000, 20);
    expect(Array.from(paddedSamples.subarray(0, 10))).toEqual(new Array(10).fill(0.5));
    expect(Array.from(paddedSamples.subarray(10))).toEqual(new Array(10).fill(0));
  });

  it('rechaza frecuencias no positivas', () => {
    expect(() => resampleWithLowPass([0, 1], 0, 32000)).toThrow(RangeError);
  });
});
