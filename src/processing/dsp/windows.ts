export type WindowKind = 'rectangular' | 'hann' | 'hamming' | 'blackman' | 'flat-top';

export interface WindowFunction {
  kind: WindowKind;
  coefficients: Float64Array;
  /** Media de los coeficientes: corrige la amplitud de una senoidal tras enventanar. */
  coherentGain: number;
  /** Ancho de banda equivalente de ruido en bins: corrige potencias de ruido. */
  equivalentNoiseBandwidthBins: number;
}

/** Coeficientes de las ventanas de coseno generalizado: w(n) = Σ (−1)^k a_k cos(2πkn/N). */
const cosineSumCoefficientsByKind: Record<Exclude<WindowKind, 'rectangular'>, readonly number[]> = {
  hann: [0.5, 0.5],
  hamming: [0.54, 0.46],
  blackman: [0.42, 0.5, 0.08],
  // Flat-top (SFT5F de Heinzel et al., normalizada): muy precisa en amplitud, poco en frecuencia.
  'flat-top': [0.1881, 0.36923, 0.28702, 0.13077, 0.02488],
};

/** Ventana periódica (la adecuada para análisis espectral con FFT). */
export function createWindow(kind: WindowKind, size: number): WindowFunction {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`Tamaño de ventana no válido: ${size}`);
  const coefficients = new Float64Array(size);

  if (kind === 'rectangular') {
    coefficients.fill(1);
  } else {
    const cosineTerms = cosineSumCoefficientsByKind[kind];
    for (let sampleIndex = 0; sampleIndex < size; sampleIndex++) {
      let coefficient = 0;
      for (let termIndex = 0; termIndex < cosineTerms.length; termIndex++) {
        const termSign = termIndex % 2 === 0 ? 1 : -1;
        coefficient += termSign * cosineTerms[termIndex]! * Math.cos((2 * Math.PI * termIndex * sampleIndex) / size);
      }
      coefficients[sampleIndex] = coefficient;
    }
  }

  let coefficientSum = 0;
  let squaredCoefficientSum = 0;
  for (const coefficient of coefficients) {
    coefficientSum += coefficient;
    squaredCoefficientSum += coefficient * coefficient;
  }
  return {
    kind,
    coefficients,
    coherentGain: coefficientSum / size,
    equivalentNoiseBandwidthBins: (size * squaredCoefficientSum) / (coefficientSum * coefficientSum),
  };
}

/** Multiplica muestra a muestra por la ventana, escribiendo en `output` (puede ser el mismo array). */
export function applyWindow(
  samples: ArrayLike<number>,
  windowCoefficients: Float64Array,
  output: Float32Array | Float64Array,
): void {
  'worklet';
  for (let sampleIndex = 0; sampleIndex < windowCoefficients.length; sampleIndex++) {
    output[sampleIndex] = samples[sampleIndex]! * windowCoefficients[sampleIndex]!;
  }
}
