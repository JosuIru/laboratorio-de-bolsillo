/**
 * FFT radix-2 iterativa, in situ, sobre arrays tipados. Sin reservas de memoria por llamada:
 * se prepara un plan una vez (tablas de senos/cosenos e índices bit-reversed) y se reutiliza.
 *
 * Todas las funciones de cálculo llevan 'worklet' para poder ejecutarse en el hilo de audio o
 * de cámara; el plan es un objeto plano de arrays tipados, que los worklets pueden copiar.
 */

export interface FftPlan {
  size: number;
  cosineTable: Float64Array;
  sineTable: Float64Array;
  bitReversedIndices: Uint32Array;
}

export function isPowerOfTwo(candidateSize: number): boolean {
  return Number.isInteger(candidateSize) && candidateSize > 0 && (candidateSize & (candidateSize - 1)) === 0;
}

export function createFftPlan(size: number): FftPlan {
  if (!isPowerOfTwo(size) || size < 2) throw new RangeError(`El tamaño de la FFT debe ser potencia de 2 (≥ 2): ${size}`);

  const halfSize = size / 2;
  const cosineTable = new Float64Array(halfSize);
  const sineTable = new Float64Array(halfSize);
  for (let twiddleIndex = 0; twiddleIndex < halfSize; twiddleIndex++) {
    const angle = (-2 * Math.PI * twiddleIndex) / size;
    cosineTable[twiddleIndex] = Math.cos(angle);
    sineTable[twiddleIndex] = Math.sin(angle);
  }

  const bitCount = Math.log2(size);
  const bitReversedIndices = new Uint32Array(size);
  for (let sampleIndex = 0; sampleIndex < size; sampleIndex++) {
    let reversedIndex = 0;
    for (let bitPosition = 0; bitPosition < bitCount; bitPosition++) {
      reversedIndex = (reversedIndex << 1) | ((sampleIndex >> bitPosition) & 1);
    }
    bitReversedIndices[sampleIndex] = reversedIndex;
  }

  return { size, cosineTable, sineTable, bitReversedIndices };
}

/** Transformada directa in situ: `real` e `imaginary` se sobrescriben con el resultado. */
export function fftInPlace(plan: FftPlan, real: Float32Array | Float64Array, imaginary: Float32Array | Float64Array): void {
  'worklet';
  const { size, cosineTable, sineTable, bitReversedIndices } = plan;
  if (real.length !== size || imaginary.length !== size) {
    throw new RangeError(`Se esperaban arrays de ${size} elementos`);
  }

  for (let sampleIndex = 0; sampleIndex < size; sampleIndex++) {
    const reversedIndex = bitReversedIndices[sampleIndex]!;
    if (reversedIndex > sampleIndex) {
      const realTemporary = real[sampleIndex]!;
      real[sampleIndex] = real[reversedIndex]!;
      real[reversedIndex] = realTemporary;
      const imaginaryTemporary = imaginary[sampleIndex]!;
      imaginary[sampleIndex] = imaginary[reversedIndex]!;
      imaginary[reversedIndex] = imaginaryTemporary;
    }
  }

  for (let blockSize = 2; blockSize <= size; blockSize *= 2) {
    const halfBlockSize = blockSize / 2;
    const twiddleStride = size / blockSize;
    for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
      for (let pairOffset = 0; pairOffset < halfBlockSize; pairOffset++) {
        const twiddleIndex = pairOffset * twiddleStride;
        const twiddleReal = cosineTable[twiddleIndex]!;
        const twiddleImaginary = sineTable[twiddleIndex]!;
        const evenIndex = blockStart + pairOffset;
        const oddIndex = evenIndex + halfBlockSize;
        const oddReal = real[oddIndex]!;
        const oddImaginary = imaginary[oddIndex]!;
        const productReal = oddReal * twiddleReal - oddImaginary * twiddleImaginary;
        const productImaginary = oddReal * twiddleImaginary + oddImaginary * twiddleReal;
        real[oddIndex] = real[evenIndex]! - productReal;
        imaginary[oddIndex] = imaginary[evenIndex]! - productImaginary;
        real[evenIndex] = real[evenIndex]! + productReal;
        imaginary[evenIndex] = imaginary[evenIndex]! + productImaginary;
      }
    }
  }
}

/** Transformada inversa in situ (normalizada: `ifft(fft(x)) = x`). */
export function inverseFftInPlace(
  plan: FftPlan,
  real: Float32Array | Float64Array,
  imaginary: Float32Array | Float64Array,
): void {
  'worklet';
  const { size } = plan;
  for (let binIndex = 0; binIndex < size; binIndex++) imaginary[binIndex] = -imaginary[binIndex]!;
  fftInPlace(plan, real, imaginary);
  for (let sampleIndex = 0; sampleIndex < size; sampleIndex++) {
    real[sampleIndex] = real[sampleIndex]! / size;
    imaginary[sampleIndex] = -imaginary[sampleIndex]! / size;
  }
}
