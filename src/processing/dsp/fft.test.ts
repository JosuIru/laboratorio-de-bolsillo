import { createFftPlan, fftInPlace, inverseFftInPlace, isPowerOfTwo } from './fft';

/** DFT directa O(n²), como referencia. */
function referenceDft(inputReal: number[], inputImaginary: number[]) {
  const size = inputReal.length;
  const outputReal = new Array<number>(size).fill(0);
  const outputImaginary = new Array<number>(size).fill(0);
  for (let binIndex = 0; binIndex < size; binIndex++) {
    for (let sampleIndex = 0; sampleIndex < size; sampleIndex++) {
      const angle = (-2 * Math.PI * binIndex * sampleIndex) / size;
      outputReal[binIndex]! += inputReal[sampleIndex]! * Math.cos(angle) - inputImaginary[sampleIndex]! * Math.sin(angle);
      outputImaginary[binIndex]! += inputReal[sampleIndex]! * Math.sin(angle) + inputImaginary[sampleIndex]! * Math.cos(angle);
    }
  }
  return { outputReal, outputImaginary };
}

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

describe('isPowerOfTwo', () => {
  it.each([
    [1, true],
    [2, true],
    [1024, true],
    [0, false],
    [3, false],
    [1000, false],
    [2.5, false],
  ])('%p → %p', (candidateSize, isExpectedPowerOfTwo) => {
    expect(isPowerOfTwo(candidateSize)).toBe(isExpectedPowerOfTwo);
  });
});

describe('createFftPlan', () => {
  it('rechaza tamaños que no son potencia de 2', () => {
    expect(() => createFftPlan(1000)).toThrow(RangeError);
    expect(() => createFftPlan(1)).toThrow(RangeError);
  });
});

describe('fftInPlace', () => {
  it.each([2, 8, 64, 256])('coincide con la DFT directa (n = %i)', (size) => {
    const nextRandom = seededRandom(size);
    const inputReal = Array.from({ length: size }, nextRandom);
    const inputImaginary = Array.from({ length: size }, nextRandom);
    const { outputReal, outputImaginary } = referenceDft(inputReal, inputImaginary);

    const real = Float64Array.from(inputReal);
    const imaginary = Float64Array.from(inputImaginary);
    fftInPlace(createFftPlan(size), real, imaginary);

    for (let binIndex = 0; binIndex < size; binIndex++) {
      expect(real[binIndex]).toBeCloseTo(outputReal[binIndex]!, 9);
      expect(imaginary[binIndex]).toBeCloseTo(outputImaginary[binIndex]!, 9);
    }
  });

  it('una senoidal de k ciclos concentra la energía en los bins k y n−k', () => {
    const size = 64;
    const cycleCount = 5;
    const real = Float64Array.from({ length: size }, (_, sampleIndex) =>
      Math.sin((2 * Math.PI * cycleCount * sampleIndex) / size),
    );
    const imaginary = new Float64Array(size);
    fftInPlace(createFftPlan(size), real, imaginary);
    const magnitudes = Array.from(real, (realPart, binIndex) => Math.hypot(realPart, imaginary[binIndex]!));
    expect(magnitudes[cycleCount]).toBeCloseTo(size / 2, 9);
    expect(magnitudes[size - cycleCount]).toBeCloseTo(size / 2, 9);
    const leakedEnergy = magnitudes.filter((_, binIndex) => binIndex !== cycleCount && binIndex !== size - cycleCount);
    for (const leakedMagnitude of leakedEnergy) expect(leakedMagnitude).toBeLessThan(1e-9);
  });

  it('funciona con Float32Array', () => {
    const real = new Float32Array([1, 0, 0, 0]);
    const imaginary = new Float32Array(4);
    fftInPlace(createFftPlan(4), real, imaginary);
    expect(Array.from(real)).toEqual([1, 1, 1, 1]);
  });

  it('rechaza arrays de otro tamaño', () => {
    expect(() => fftInPlace(createFftPlan(8), new Float64Array(4), new Float64Array(4))).toThrow(RangeError);
  });
});

describe('inverseFftInPlace', () => {
  it('recupera la señal original', () => {
    const size = 128;
    const nextRandom = seededRandom(7);
    const originalReal = Float64Array.from({ length: size }, nextRandom);
    const real = Float64Array.from(originalReal);
    const imaginary = new Float64Array(size);
    const plan = createFftPlan(size);
    fftInPlace(plan, real, imaginary);
    inverseFftInPlace(plan, real, imaginary);
    for (let sampleIndex = 0; sampleIndex < size; sampleIndex++) {
      expect(real[sampleIndex]).toBeCloseTo(originalReal[sampleIndex]!, 12);
      expect(imaginary[sampleIndex]).toBeCloseTo(0, 12);
    }
  });
});
