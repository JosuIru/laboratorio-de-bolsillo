/**
 * Remuestreo de audio con filtro antialias (interpolación sinc con ventana de Blackman).
 *
 * El micrófono suele dar 48 kHz o 44,1 kHz y el modelo quiere 32 kHz. Interpolar sin filtrar
 * dejaría pasar como «fantasmas» graves lo que hay por encima de 16 kHz (insectos, ultrasonidos
 * de murciélagos, ruido eléctrico): el filtro corta un poco por debajo de la nueva frecuencia de
 * Nyquist antes de interpolar. Es un remuestreador de ventana entera (no de flujo): se aplica a
 * cada trozo de 5 s por separado.
 */

/** Pasos por cero del sinc a cada lado: más, mejor corte pero más cálculo. */
const sincZeroCrossingsPerSide = 10;
/** Fracción de la nueva frecuencia de Nyquist donde empieza el corte (deja margen a la transición). */
const cutoffFractionOfNyquist = 0.92;
/** Resolución de la tabla del núcleo: posiciones por muestra de origen. */
const kernelTableStepsPerSample = 256;

interface ResamplingKernel {
  halfWidthSamples: number;
  cutoffRatio: number;
  kernelTable: Float32Array;
}

const kernelCache = new Map<string, ResamplingKernel>();

function blackmanWindow(normalizedPosition: number): number {
  // normalizedPosition en [-1, 1]; 0 en el centro.
  const phase = Math.PI * (normalizedPosition + 1);
  return 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
}

function buildKernel(sourceRateHz: number, targetRateHz: number): ResamplingKernel {
  const cacheKey = `${sourceRateHz}-${targetRateHz}`;
  const cachedKernel = kernelCache.get(cacheKey);
  if (cachedKernel) return cachedKernel;
  // Frecuencia de corte relativa a la de Nyquist de origen (1 = sin filtrar).
  const cutoffRatio = Math.min(1, targetRateHz / sourceRateHz) * cutoffFractionOfNyquist;
  const halfWidthSamples = Math.ceil(sincZeroCrossingsPerSide / cutoffRatio);
  const tableLength = halfWidthSamples * kernelTableStepsPerSample + 2;
  const kernelTable = new Float32Array(tableLength);
  for (let tableIndex = 0; tableIndex < tableLength; tableIndex++) {
    const distanceSamples = tableIndex / kernelTableStepsPerSample;
    if (distanceSamples >= halfWidthSamples) continue;
    const sincArgument = Math.PI * cutoffRatio * distanceSamples;
    const sincValue = sincArgument === 0 ? 1 : Math.sin(sincArgument) / sincArgument;
    kernelTable[tableIndex] = cutoffRatio * sincValue * blackmanWindow(distanceSamples / halfWidthSamples);
  }
  const kernel = { halfWidthSamples, cutoffRatio, kernelTable };
  kernelCache.set(cacheKey, kernel);
  return kernel;
}

/**
 * Remuestrea `inputSamples` de `sourceRateHz` a `targetRateHz`. Fuera del trozo se supone
 * silencio. `outputLength` fija la longitud de salida (se rellena con ceros si falta audio);
 * por defecto, la que corresponde a la duración de la entrada.
 */
export function resampleWithLowPass(
  inputSamples: ArrayLike<number>,
  sourceRateHz: number,
  targetRateHz: number,
  outputLength: number = Math.floor((inputSamples.length * targetRateHz) / sourceRateHz),
): Float32Array {
  if (!(sourceRateHz > 0) || !(targetRateHz > 0)) throw new RangeError('Las frecuencias deben ser positivas');
  const outputSamples = new Float32Array(outputLength);
  const inputLength = inputSamples.length;
  if (sourceRateHz === targetRateHz) {
    for (let sampleIndex = 0; sampleIndex < Math.min(outputLength, inputLength); sampleIndex++) {
      outputSamples[sampleIndex] = inputSamples[sampleIndex]!;
    }
    return outputSamples;
  }
  const { halfWidthSamples, kernelTable } = buildKernel(sourceRateHz, targetRateHz);
  const sourceStepPerOutput = sourceRateHz / targetRateHz;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
    const sourcePosition = outputIndex * sourceStepPerOutput;
    const centerIndex = Math.floor(sourcePosition);
    const firstIndex = Math.max(0, centerIndex - halfWidthSamples + 1);
    const lastIndex = Math.min(inputLength - 1, centerIndex + halfWidthSamples);
    let weightedSum = 0;
    let weightSum = 0;
    for (let sourceIndex = firstIndex; sourceIndex <= lastIndex; sourceIndex++) {
      const tablePosition = Math.abs(sourcePosition - sourceIndex) * kernelTableStepsPerSample;
      const lowerTableIndex = Math.floor(tablePosition);
      const tableFraction = tablePosition - lowerTableIndex;
      const kernelWeight =
        kernelTable[lowerTableIndex]! + tableFraction * (kernelTable[lowerTableIndex + 1]! - kernelTable[lowerTableIndex]!);
      weightedSum += kernelWeight * inputSamples[sourceIndex]!;
      weightSum += kernelWeight;
    }
    // Dentro del trozo la suma de pesos es ≈1 (ganancia unidad en continua). En los bordes, donde
    // falta la mitad del núcleo, no se normaliza: el silencio de fuera cuenta como tal.
    const isInterior = centerIndex - halfWidthSamples + 1 >= 0 && centerIndex + halfWidthSamples < inputLength;
    outputSamples[outputIndex] = isInterior && weightSum !== 0 ? weightedSum / weightSum : weightedSum;
  }
  return outputSamples;
}
