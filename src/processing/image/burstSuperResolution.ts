/**
 * Superresolución a partir de una ráfaga tomada a mano (versión simplificada de «Handheld
 * Multi-Frame Super-Resolution», Wronski et al. 2019).
 *
 * El temblor de la mano desplaza cada fotograma una fracción de píxel distinta, así que entre
 * todos muestrean la escena en más posiciones que uno solo. Se alinea cada fotograma con el más
 * nítido con precisión subpíxel y se reparten sus píxeles sobre una rejilla más fina, pesando
 * cada muestra por su distancia y por lo que se parece a la referencia (así lo que se ha movido
 * en la escena no deja fantasmas). Con fotos ya procesadas por el móvil (no RAW) la ganancia
 * real es de 1,2 a 1,5 veces más detalle y bastante menos ruido.
 *
 * Todas las imágenes son cuadradas (`size`²) y RGB de 8 bits, como los recortes de la Luna.
 * Los bucles están escritos para Hermes (sin JIT): pesos precalculados por fila y columna y
 * sin llamadas a funciones por píxel.
 */

import { type FloatRgbImage, measureCropSharpness } from './lunarStacking';

/** Posición en el fotograma de lo que en la referencia está en (x, y): (x + offsetX, y + offsetY). */
export interface FrameOffset {
  offsetX: number;
  offsetY: number;
}

interface LuminancePlane {
  values: Float32Array;
  size: number;
}

/** La pirámide de alineado baja hasta que el lado queda por debajo del doble de esto. */
const minimumPyramidSize = 48;
const lucasKanadeIterations = 5;
const lucasKanadeConvergencePixels = 0.01;
/** Salto entre los puntos con que se afina el alineado: de sobra para una traslación. */
const lucasKanadeSampleStride = 3;
/** Ruido mínimo (en niveles de luminancia 0-255) para el peso de parecido. */
const minimumNoiseLevel = 4;
/** Cuántas desviaciones de ruido se toleran antes de considerar que algo se ha movido. */
const robustnessToleranceFactor = 3;
/** Por debajo de este peso de parecido, el fotograma no aporta nada en ese punto. */
const negligibleRobustnessWeight = 0.01;

export function computeLuminance(rgbPixels: Uint8Array, size: number): Float32Array {
  const luminance = new Float32Array(size * size);
  for (let pixelIndex = 0; pixelIndex < luminance.length; pixelIndex++) {
    const pixelOffset = pixelIndex * 3;
    luminance[pixelIndex] =
      0.299 * rgbPixels[pixelOffset]! + 0.587 * rgbPixels[pixelOffset + 1]! + 0.114 * rgbPixels[pixelOffset + 2]!;
  }
  return luminance;
}

/** Núcleo binomial 1-4-6-4-1: filtro paso bajo barato que evita el aliasing al reducir. */
const binomialKernel = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16] as const;

/** Mitad de resolución de una pirámide gaussiana: suaviza (bordes replicados) y se queda un píxel de cada dos. */
function downsampleByTwo(plane: LuminancePlane): LuminancePlane {
  const { size, values } = plane;
  const halfSize = Math.floor(size / 2);
  // Índice de cada uno de los 5 vecinos (−2…+2) de cada posición, con el borde replicado.
  const neighbourIndices = new Int32Array(size * 5);
  for (let position = 0; position < size; position++) {
    for (let kernelIndex = 0; kernelIndex < 5; kernelIndex++) {
      neighbourIndices[position * 5 + kernelIndex] = Math.min(size - 1, Math.max(0, position + kernelIndex - 2));
    }
  }
  const [outerWeight, innerWeight, centreWeight] = [binomialKernel[0], binomialKernel[1], binomialKernel[2]];
  // Primero se suavizan en horizontal solo las columnas pares, que son las que se quedan.
  const horizontallySmoothed = new Float32Array(size * halfSize);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    const rowStart = rowIndex * size;
    for (let halfColumn = 0; halfColumn < halfSize; halfColumn++) {
      const neighbourStart = 2 * halfColumn * 5;
      horizontallySmoothed[rowIndex * halfSize + halfColumn] =
        outerWeight * (values[rowStart + neighbourIndices[neighbourStart]!]! + values[rowStart + neighbourIndices[neighbourStart + 4]!]!) +
        innerWeight * (values[rowStart + neighbourIndices[neighbourStart + 1]!]! + values[rowStart + neighbourIndices[neighbourStart + 3]!]!) +
        centreWeight * values[rowStart + neighbourIndices[neighbourStart + 2]!]!;
    }
  }
  const halfValues = new Float32Array(halfSize * halfSize);
  for (let halfRow = 0; halfRow < halfSize; halfRow++) {
    const neighbourStart = 2 * halfRow * 5;
    const outerAboveStart = neighbourIndices[neighbourStart]! * halfSize;
    const innerAboveStart = neighbourIndices[neighbourStart + 1]! * halfSize;
    const centreStart = neighbourIndices[neighbourStart + 2]! * halfSize;
    const innerBelowStart = neighbourIndices[neighbourStart + 3]! * halfSize;
    const outerBelowStart = neighbourIndices[neighbourStart + 4]! * halfSize;
    for (let halfColumn = 0; halfColumn < halfSize; halfColumn++) {
      halfValues[halfRow * halfSize + halfColumn] =
        outerWeight * (horizontallySmoothed[outerAboveStart + halfColumn]! + horizontallySmoothed[outerBelowStart + halfColumn]!) +
        innerWeight * (horizontallySmoothed[innerAboveStart + halfColumn]! + horizontallySmoothed[innerBelowStart + halfColumn]!) +
        centreWeight * horizontallySmoothed[centreStart + halfColumn]!;
    }
  }
  return { values: halfValues, size: halfSize };
}

function buildPyramid(plane: LuminancePlane): LuminancePlane[] {
  const pyramid = [plane];
  let coarsestPlane = plane;
  while (coarsestPlane.size / 2 >= minimumPyramidSize) {
    coarsestPlane = downsampleByTwo(coarsestPlane);
    pyramid.push(coarsestPlane);
  }
  return pyramid;
}

function meanSquaredDifference(
  reference: LuminancePlane,
  target: LuminancePlane,
  shiftX: number,
  shiftY: number,
  margin: number,
  sampleStride: number,
): number {
  const { size } = reference;
  const referenceValues = reference.values;
  const targetValues = target.values;
  let squaredDifferenceSum = 0;
  let sampleCount = 0;
  for (let rowIndex = margin; rowIndex < size - margin; rowIndex += sampleStride) {
    const targetRow = rowIndex + shiftY;
    if (targetRow < 0 || targetRow >= size) continue;
    const referenceRowStart = rowIndex * size;
    const targetRowStart = targetRow * size + shiftX;
    for (let columnIndex = margin; columnIndex < size - margin; columnIndex += sampleStride) {
      const targetColumn = columnIndex + shiftX;
      if (targetColumn < 0 || targetColumn >= size) continue;
      const difference = referenceValues[referenceRowStart + columnIndex]! - targetValues[targetRowStart + columnIndex]!;
      squaredDifferenceSum += difference * difference;
      sampleCount++;
    }
  }
  return sampleCount > 0 ? squaredDifferenceSum / sampleCount : Number.POSITIVE_INFINITY;
}

/** Alinea fotogramas con una referencia fija; lo que depende solo de ella se calcula una vez. */
export type FrameAligner = (targetLuminance: Float32Array) => FrameOffset;

/**
 * Prepara el alineado con `referenceLuminance`: su pirámide gaussiana y, para afinar con
 * Lucas-Kanade, sus gradientes y la matriz que forman (en la variante que usa los gradientes de
 * la referencia en vez de los del fotograma, válida para traslaciones y mucho más barata).
 * Los fotogramas deben tener el mismo brillo medio que la referencia.
 */
export function createFrameAligner(referenceLuminance: Float32Array, size: number, maximumShiftPixels: number): FrameAligner {
  const referencePyramid = buildPyramid({ values: referenceLuminance, size });
  const coarsestLevel = referencePyramid.length - 1;
  const refinementMargin = Math.min(Math.floor(size / 4), Math.ceil(maximumShiftPixels) + 8);

  const refinementPointIndices: number[] = [];
  const gradientXValues: number[] = [];
  const gradientYValues: number[] = [];
  let gradientXSquaredSum = 0;
  let gradientYSquaredSum = 0;
  let gradientProductSum = 0;
  for (let rowIndex = refinementMargin; rowIndex < size - refinementMargin; rowIndex += lucasKanadeSampleStride) {
    for (let columnIndex = refinementMargin; columnIndex < size - refinementMargin; columnIndex += lucasKanadeSampleStride) {
      const pixelIndex = rowIndex * size + columnIndex;
      const gradientX = (referenceLuminance[pixelIndex + 1]! - referenceLuminance[pixelIndex - 1]!) / 2;
      const gradientY = (referenceLuminance[pixelIndex + size]! - referenceLuminance[pixelIndex - size]!) / 2;
      refinementPointIndices.push(pixelIndex);
      gradientXValues.push(gradientX);
      gradientYValues.push(gradientY);
      gradientXSquaredSum += gradientX * gradientX;
      gradientYSquaredSum += gradientY * gradientY;
      gradientProductSum += gradientX * gradientY;
    }
  }
  const gradientDeterminant = gradientXSquaredSum * gradientYSquaredSum - gradientProductSum * gradientProductSum;

  function refineWithLucasKanade(targetValues: Float32Array, initialOffset: FrameOffset): FrameOffset {
    let { offsetX, offsetY } = initialOffset;
    if (gradientDeterminant <= 1e-9) return { offsetX, offsetY };
    for (let iterationIndex = 0; iterationIndex < lucasKanadeIterations; iterationIndex++) {
      const integerShiftX = Math.floor(offsetX);
      const integerShiftY = Math.floor(offsetY);
      const horizontalWeight = offsetX - integerShiftX;
      const verticalWeight = offsetY - integerShiftY;
      const shiftIndex = integerShiftY * size + integerShiftX;
      let errorGradientXSum = 0;
      let errorGradientYSum = 0;
      for (let pointIndex = 0; pointIndex < refinementPointIndices.length; pointIndex++) {
        const referenceIndex = refinementPointIndices[pointIndex]!;
        const topLeftIndex = referenceIndex + shiftIndex;
        const topValue = targetValues[topLeftIndex]! + horizontalWeight * (targetValues[topLeftIndex + 1]! - targetValues[topLeftIndex]!);
        const bottomValue =
          targetValues[topLeftIndex + size]! +
          horizontalWeight * (targetValues[topLeftIndex + size + 1]! - targetValues[topLeftIndex + size]!);
        const error = referenceLuminance[referenceIndex]! - (topValue + verticalWeight * (bottomValue - topValue));
        errorGradientXSum += error * gradientXValues[pointIndex]!;
        errorGradientYSum += error * gradientYValues[pointIndex]!;
      }
      // Alineados, el gradiente del fotograma en x + desplazamiento es el de la referencia en x.
      const correctionX = (gradientYSquaredSum * errorGradientXSum - gradientProductSum * errorGradientYSum) / gradientDeterminant;
      const correctionY = (gradientXSquaredSum * errorGradientYSum - gradientProductSum * errorGradientXSum) / gradientDeterminant;
      // Una corrección de más de un píxel indica que no converge (zona sin textura): se deja.
      if (Math.abs(correctionX) > 1 || Math.abs(correctionY) > 1) break;
      offsetX += correctionX;
      offsetY += correctionY;
      if (Math.hypot(correctionX, correctionY) < lucasKanadeConvergencePixels) break;
    }
    return { offsetX, offsetY };
  }

  return (targetLuminance: Float32Array) => {
    const targetPyramid = buildPyramid({ values: targetLuminance, size });
    let shiftX = 0;
    let shiftY = 0;
    for (let levelIndex = coarsestLevel; levelIndex >= 0; levelIndex--) {
      const referencePlane = referencePyramid[levelIndex]!;
      const targetPlane = targetPyramid[levelIndex]!;
      let searchRadius: number;
      if (levelIndex === coarsestLevel) {
        searchRadius = Math.max(1, Math.ceil(maximumShiftPixels / 2 ** levelIndex));
      } else {
        shiftX *= 2;
        shiftY *= 2;
        searchRadius = levelIndex === 0 ? 1 : 2;
      }
      const margin = Math.min(
        Math.floor(referencePlane.size / 4),
        searchRadius + Math.max(Math.abs(shiftX), Math.abs(shiftY)) + 1,
      );
      const sampleStride = levelIndex === coarsestLevel ? 1 : 2;
      let bestShiftX = shiftX;
      let bestShiftY = shiftY;
      let bestCost = Number.POSITIVE_INFINITY;
      for (let candidateY = shiftY - searchRadius; candidateY <= shiftY + searchRadius; candidateY++) {
        for (let candidateX = shiftX - searchRadius; candidateX <= shiftX + searchRadius; candidateX++) {
          const cost = meanSquaredDifference(referencePlane, targetPlane, candidateX, candidateY, margin, sampleStride);
          if (cost < bestCost) {
            bestCost = cost;
            bestShiftX = candidateX;
            bestShiftY = candidateY;
          }
        }
      }
      shiftX = bestShiftX;
      shiftY = bestShiftY;
    }
    // Si el desplazamiento se sale del margen de afinado, se queda en el valor entero.
    if (Math.max(Math.abs(shiftX), Math.abs(shiftY)) + 2 > refinementMargin) return { offsetX: shiftX, offsetY: shiftY };
    return refineWithLucasKanade(targetLuminance, { offsetX: shiftX, offsetY: shiftY });
  };
}

/**
 * Desplazamiento de `target` respecto a `reference` (traslación, con precisión subpíxel).
 * Busca en una pirámide de resoluciones, de la más gruesa a la completa, y afina con
 * Lucas-Kanade. Para alinear varios fotogramas con la misma referencia, `createFrameAligner`.
 */
export function estimateFrameOffset(
  referenceLuminance: Float32Array,
  targetLuminance: Float32Array,
  size: number,
  maximumShiftPixels: number,
): FrameOffset {
  return createFrameAligner(referenceLuminance, size, maximumShiftPixels)(targetLuminance);
}

function meanOf(values: Float32Array): number {
  let valueSum = 0;
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) valueSum += values[valueIndex]!;
  return values.length > 0 ? valueSum / values.length : 0;
}

/** Copia de la luminancia con el mismo brillo medio que la referencia (la exposición varía un poco). */
function matchBrightness(luminance: Float32Array, referenceMean: number): Float32Array {
  const luminanceMean = meanOf(luminance);
  const brightnessGain = luminanceMean > 0 ? referenceMean / luminanceMean : 1;
  const matchedLuminance = new Float32Array(luminance.length);
  for (let valueIndex = 0; valueIndex < luminance.length; valueIndex++) {
    matchedLuminance[valueIndex] = luminance[valueIndex]! * brightnessGain;
  }
  return matchedLuminance;
}

/** Suma 3×3 separable (sin salirse de la imagen). */
function boxSumThreeByThree(values: Float32Array, size: number): Float32Array {
  const horizontalSums = new Float32Array(size * size);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    const rowStart = rowIndex * size;
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      let neighbourSum = values[rowStart + columnIndex]!;
      if (columnIndex > 0) neighbourSum += values[rowStart + columnIndex - 1]!;
      if (columnIndex < size - 1) neighbourSum += values[rowStart + columnIndex + 1]!;
      horizontalSums[rowStart + columnIndex] = neighbourSum;
    }
  }
  const boxSums = new Float32Array(size * size);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      const pixelIndex = rowIndex * size + columnIndex;
      let neighbourSum = horizontalSums[pixelIndex]!;
      if (rowIndex > 0) neighbourSum += horizontalSums[pixelIndex - size]!;
      if (rowIndex < size - 1) neighbourSum += horizontalSums[pixelIndex + size]!;
      boxSums[pixelIndex] = neighbourSum;
    }
  }
  return boxSums;
}

/**
 * Peso de 0 a 1 por píxel de la referencia: cuánto se parece el fotograma alineado a ella.
 * Donde algo se ha movido (una persona, una hoja) la diferencia supera el ruido y el peso cae,
 * así ese fotograma no aporta ahí. El nivel de ruido se estima de la propia diferencia (MAD) y
 * la diferencia se promedia en 3×3 para que un píxel ruidoso suelto no anule su fotograma.
 */
export function computeRobustnessMap(
  referenceLuminance: Float32Array,
  alignedTargetLuminance: Float32Array,
  size: number,
  offset: FrameOffset,
): Float32Array {
  const integerShiftX = Math.floor(offset.offsetX);
  const integerShiftY = Math.floor(offset.offsetY);
  const horizontalWeight = offset.offsetX - integerShiftX;
  const verticalWeight = offset.offsetY - integerShiftY;
  const squaredDifferences = new Float32Array(size * size);
  const validity = new Float32Array(size * size);
  const sampledAbsoluteDifferences: number[] = [];
  // La muestra bilineal necesita el píxel siguiente en cada eje, dentro de la imagen.
  const firstValidColumn = Math.max(0, -integerShiftX);
  const lastValidColumn = Math.min(size - 1, size - 2 - integerShiftX);
  const firstValidRow = Math.max(0, -integerShiftY);
  const lastValidRow = Math.min(size - 1, size - 2 - integerShiftY);
  for (let rowIndex = firstValidRow; rowIndex <= lastValidRow; rowIndex++) {
    const targetRowStart = (rowIndex + integerShiftY) * size + integerShiftX;
    for (let columnIndex = firstValidColumn; columnIndex <= lastValidColumn; columnIndex++) {
      const topLeftIndex = targetRowStart + columnIndex;
      const topValue =
        alignedTargetLuminance[topLeftIndex]! +
        horizontalWeight * (alignedTargetLuminance[topLeftIndex + 1]! - alignedTargetLuminance[topLeftIndex]!);
      const bottomValue =
        alignedTargetLuminance[topLeftIndex + size]! +
        horizontalWeight * (alignedTargetLuminance[topLeftIndex + size + 1]! - alignedTargetLuminance[topLeftIndex + size]!);
      const difference = referenceLuminance[rowIndex * size + columnIndex]! - (topValue + verticalWeight * (bottomValue - topValue));
      squaredDifferences[rowIndex * size + columnIndex] = difference * difference;
      validity[rowIndex * size + columnIndex] = 1;
      if ((rowIndex & 3) === 0 && (columnIndex & 3) === 0) sampledAbsoluteDifferences.push(Math.abs(difference));
    }
  }
  sampledAbsoluteDifferences.sort((firstValue, secondValue) => firstValue - secondValue);
  const medianAbsoluteDifference = sampledAbsoluteDifferences[Math.floor(sampledAbsoluteDifferences.length / 2)] ?? 0;
  // 1,4826 × MAD estima la desviación típica si el ruido es gaussiano.
  const noiseLevel = Math.max(minimumNoiseLevel, 1.4826 * medianAbsoluteDifference);
  const inverseTwiceToleranceSquared = 1 / (2 * (robustnessToleranceFactor * noiseLevel) ** 2);

  const squaredDifferenceSums = boxSumThreeByThree(squaredDifferences, size);
  const validNeighbourCounts = boxSumThreeByThree(validity, size);
  const robustnessWeights = new Float32Array(size * size);
  for (let pixelIndex = 0; pixelIndex < robustnessWeights.length; pixelIndex++) {
    if (validity[pixelIndex] === 0) continue;
    const meanSquaredDifferenceNearby = squaredDifferenceSums[pixelIndex]! / validNeighbourCounts[pixelIndex]!;
    robustnessWeights[pixelIndex] = Math.exp(-meanSquaredDifferenceNearby * inverseTwiceToleranceSquared);
  }
  return robustnessWeights;
}

/**
 * Para cada coordenada de salida (fila o columna), los dos píxeles de entrada que la rodean y
 * sus pesos. Pesos a 0 para los que caen fuera de la imagen (el índice se deja dentro).
 */
interface AxisSampling {
  firstIndices: Int32Array;
  secondIndices: Int32Array;
  firstWeights: Float32Array;
  secondWeights: Float32Array;
}

function createGaussianAxisSampling(size: number, scale: number, offset: number, inverseTwiceSigmaSquared: number): AxisSampling {
  const outputSize = size * scale;
  const axisSampling: AxisSampling = {
    firstIndices: new Int32Array(outputSize),
    secondIndices: new Int32Array(outputSize),
    firstWeights: new Float32Array(outputSize),
    secondWeights: new Float32Array(outputSize),
  };
  for (let outputCoordinate = 0; outputCoordinate < outputSize; outputCoordinate++) {
    const inputPosition = (outputCoordinate + 0.5) / scale - 0.5 + offset;
    const firstIndex = Math.floor(inputPosition);
    const secondIndex = firstIndex + 1;
    const firstDistance = inputPosition - firstIndex;
    const secondDistance = secondIndex - inputPosition;
    axisSampling.firstIndices[outputCoordinate] = Math.min(size - 1, Math.max(0, firstIndex));
    axisSampling.secondIndices[outputCoordinate] = Math.min(size - 1, Math.max(0, secondIndex));
    axisSampling.firstWeights[outputCoordinate] =
      firstIndex >= 0 && firstIndex < size ? Math.exp(-firstDistance * firstDistance * inverseTwiceSigmaSquared) : 0;
    axisSampling.secondWeights[outputCoordinate] =
      secondIndex >= 0 && secondIndex < size ? Math.exp(-secondDistance * secondDistance * inverseTwiceSigmaSquared) : 0;
  }
  return axisSampling;
}

/** Como la gaussiana, pero con pesos bilineales y repitiendo el borde fuera de la imagen. */
function createBilinearAxisSampling(size: number, scale: number): AxisSampling {
  const outputSize = size * scale;
  const axisSampling: AxisSampling = {
    firstIndices: new Int32Array(outputSize),
    secondIndices: new Int32Array(outputSize),
    firstWeights: new Float32Array(outputSize),
    secondWeights: new Float32Array(outputSize),
  };
  for (let outputCoordinate = 0; outputCoordinate < outputSize; outputCoordinate++) {
    const inputPosition = Math.min(size - 1, Math.max(0, (outputCoordinate + 0.5) / scale - 0.5));
    const firstIndex = Math.min(size - 2, Math.floor(inputPosition));
    const secondWeight = inputPosition - firstIndex;
    axisSampling.firstIndices[outputCoordinate] = firstIndex;
    axisSampling.secondIndices[outputCoordinate] = firstIndex + 1;
    axisSampling.firstWeights[outputCoordinate] = 1 - secondWeight;
    axisSampling.secondWeights[outputCoordinate] = secondWeight;
  }
  return axisSampling;
}

export interface MergeOptions {
  /** Factor de ampliación de la rejilla de salida (2 = el doble de lado). */
  scale: number;
  /**
   * Anchura (en píxeles de entrada) del núcleo gaussiano con que se reparte cada muestra. Cuanto
   * más estrecho, más detalle, pero hacen falta más fotogramas para que no queden huecos: ver
   * `kernelSigmaForFrameCount`.
   */
  kernelSigmaPixels: number;
}

/**
 * Núcleo según cuántos fotogramas se fusionan: con muchos, las muestras cubren bien la rejilla
 * fina y el núcleo puede ser estrecho (más nitidez); con pocos, se ensancha para no dejar huecos.
 */
export function kernelSigmaForFrameCount(frameCount: number): number {
  return Math.min(0.55, Math.max(0.25, 0.9 / Math.sqrt(Math.max(1, frameCount))));
}

/**
 * Reparte los píxeles de todos los fotogramas sobre una rejilla `scale` veces más fina. Cada
 * píxel de salida recoge los 2×2 píxeles más cercanos de cada fotograma, pesados por la
 * distancia a su posición real (gaussiana, separable en filas y columnas) y por el mapa de
 * parecido. `null` en `robustnessMaps` = peso 1 (la referencia).
 */
export function mergeFramesToFinerGrid(
  frames: readonly Uint8Array[],
  frameOffsets: readonly FrameOffset[],
  robustnessMaps: readonly (Float32Array | null)[],
  size: number,
  { scale, kernelSigmaPixels }: MergeOptions,
): FloatRgbImage {
  const outputSize = size * scale;
  const channelSums = new Float32Array(outputSize * outputSize * 3);
  const weightSums = new Float32Array(outputSize * outputSize);
  const inverseTwiceSigmaSquared = 1 / (2 * kernelSigmaPixels * kernelSigmaPixels);
  // Píxel de la referencia más cercano a cada coordenada de salida, para leer el peso de parecido.
  const nearestReferenceIndices = new Int32Array(outputSize);
  for (let outputCoordinate = 0; outputCoordinate < outputSize; outputCoordinate++) {
    nearestReferenceIndices[outputCoordinate] = Math.min(
      size - 1,
      Math.max(0, Math.round((outputCoordinate + 0.5) / scale - 0.5)),
    );
  }
  const rowStride = size * 3;

  frames.forEach((framePixels, frameIndex) => {
    const { offsetX, offsetY } = frameOffsets[frameIndex]!;
    const robustnessMap = robustnessMaps[frameIndex] ?? null;
    const columnSampling = createGaussianAxisSampling(size, scale, offsetX, inverseTwiceSigmaSquared);
    const rowSampling = createGaussianAxisSampling(size, scale, offsetY, inverseTwiceSigmaSquared);
    for (let outputRow = 0; outputRow < outputSize; outputRow++) {
      const topWeight = rowSampling.firstWeights[outputRow]!;
      const bottomWeight = rowSampling.secondWeights[outputRow]!;
      if (topWeight === 0 && bottomWeight === 0) continue;
      const topRowStart = rowSampling.firstIndices[outputRow]! * rowStride;
      const bottomRowStart = rowSampling.secondIndices[outputRow]! * rowStride;
      const robustnessRowStart = nearestReferenceIndices[outputRow]! * size;
      const outputRowStart = outputRow * outputSize;
      for (let outputColumn = 0; outputColumn < outputSize; outputColumn++) {
        let robustnessWeight = 1;
        if (robustnessMap) {
          robustnessWeight = robustnessMap[robustnessRowStart + nearestReferenceIndices[outputColumn]!]!;
          if (robustnessWeight < negligibleRobustnessWeight) continue;
        }
        const leftWeight = columnSampling.firstWeights[outputColumn]! * robustnessWeight;
        const rightWeight = columnSampling.secondWeights[outputColumn]! * robustnessWeight;
        const topLeftWeight = topWeight * leftWeight;
        const topRightWeight = topWeight * rightWeight;
        const bottomLeftWeight = bottomWeight * leftWeight;
        const bottomRightWeight = bottomWeight * rightWeight;
        const leftColumnOffset = columnSampling.firstIndices[outputColumn]! * 3;
        const rightColumnOffset = columnSampling.secondIndices[outputColumn]! * 3;
        const topLeftOffset = topRowStart + leftColumnOffset;
        const topRightOffset = topRowStart + rightColumnOffset;
        const bottomLeftOffset = bottomRowStart + leftColumnOffset;
        const bottomRightOffset = bottomRowStart + rightColumnOffset;
        const outputPixelIndex = outputRowStart + outputColumn;
        const sumOffset = outputPixelIndex * 3;
        for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
          channelSums[sumOffset + channelIndex] =
            channelSums[sumOffset + channelIndex]! +
            topLeftWeight * framePixels[topLeftOffset + channelIndex]! +
            topRightWeight * framePixels[topRightOffset + channelIndex]! +
            bottomLeftWeight * framePixels[bottomLeftOffset + channelIndex]! +
            bottomRightWeight * framePixels[bottomRightOffset + channelIndex]!;
        }
        weightSums[outputPixelIndex] =
          weightSums[outputPixelIndex]! + topLeftWeight + topRightWeight + bottomLeftWeight + bottomRightWeight;
      }
    }
  });

  for (let outputPixelIndex = 0; outputPixelIndex < weightSums.length; outputPixelIndex++) {
    const weightSum = weightSums[outputPixelIndex]!;
    if (weightSum <= 0) continue;
    const sumOffset = outputPixelIndex * 3;
    channelSums[sumOffset] = channelSums[sumOffset]! / weightSum;
    channelSums[sumOffset + 1] = channelSums[sumOffset + 1]! / weightSum;
    channelSums[sumOffset + 2] = channelSums[sumOffset + 2]! / weightSum;
  }
  return { size: outputSize, channels: channelSums };
}

/** Ampliación bilineal de un solo fotograma: lo que daría el zoom digital normal, para comparar. */
export function upscaleFrameBilinear(framePixels: Uint8Array, size: number, scale: number): FloatRgbImage {
  const outputSize = size * scale;
  const axisSampling = createBilinearAxisSampling(size, scale);
  const outputChannels = new Float32Array(outputSize * outputSize * 3);
  const rowStride = size * 3;
  for (let outputRow = 0; outputRow < outputSize; outputRow++) {
    const topRowStart = axisSampling.firstIndices[outputRow]! * rowStride;
    const bottomRowStart = axisSampling.secondIndices[outputRow]! * rowStride;
    const topWeight = axisSampling.firstWeights[outputRow]!;
    const bottomWeight = axisSampling.secondWeights[outputRow]!;
    for (let outputColumn = 0; outputColumn < outputSize; outputColumn++) {
      const leftColumnOffset = axisSampling.firstIndices[outputColumn]! * 3;
      const rightColumnOffset = axisSampling.secondIndices[outputColumn]! * 3;
      const leftWeight = axisSampling.firstWeights[outputColumn]!;
      const rightWeight = axisSampling.secondWeights[outputColumn]!;
      const outputOffset = (outputRow * outputSize + outputColumn) * 3;
      for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
        outputChannels[outputOffset + channelIndex] =
          topWeight *
            (leftWeight * framePixels[topRowStart + leftColumnOffset + channelIndex]! +
              rightWeight * framePixels[topRowStart + rightColumnOffset + channelIndex]!) +
          bottomWeight *
            (leftWeight * framePixels[bottomRowStart + leftColumnOffset + channelIndex]! +
              rightWeight * framePixels[bottomRowStart + rightColumnOffset + channelIndex]!);
      }
    }
  }
  return { size: outputSize, channels: outputChannels };
}

/** RGBA de 8 bits sin estirar el contraste (a diferencia de la Luna, aquí la escena ya viene bien expuesta). */
export function floatImageToRgba(image: FloatRgbImage): Uint8Array {
  const pixelCount = image.size * image.size;
  const rgbaPixels = new Uint8Array(pixelCount * 4);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
      const channelValue = image.channels[pixelIndex * 3 + channelIndex]!;
      rgbaPixels[pixelIndex * 4 + channelIndex] = channelValue < 0 ? 0 : channelValue > 255 ? 255 : Math.round(channelValue);
    }
    rgbaPixels[pixelIndex * 4 + 3] = 255;
  }
  return rgbaPixels;
}

export interface SuperResolutionOptions {
  /** Factor de ampliación de la rejilla de salida (2 = el doble de lado). */
  scale: number;
  /** Fracción más nítida de la ráfaga que se usa (al menos un fotograma). */
  keptFraction: number;
  /** Mayor desplazamiento entre fotogramas que se busca, en píxeles de entrada. */
  maximumShiftPixels: number;
}

export interface SuperResolutionResult {
  /** Sin realzar: el realce se aplica al mostrarla, según el nivel elegido. */
  image: FloatRgbImage;
  /** El fotograma de referencia ampliado de forma normal (zoom digital), para comparar. */
  singleFrameImage: FloatRgbImage;
  usedFrameCount: number;
  /** Índice (en la ráfaga recibida) del fotograma más nítido, al que se alinean los demás. */
  referenceFrameIndex: number;
  /** Desplazamiento de cada fotograma usado respecto a la referencia (el primero es ella). */
  frameOffsets: FrameOffset[];
  /** Desplazamiento medio respecto a la referencia: cuánto se ha movido la mano. */
  meanShiftPixels: number;
}

export const defaultSuperResolutionOptions: SuperResolutionOptions = {
  scale: 2,
  keptFraction: 0.75,
  maximumShiftPixels: 32,
};

/** Radio del desenfoque de la máscara de enfoque para una imagen ampliada `scale` veces. */
export function sharpeningSigmaForScale(scale: number): number {
  return 0.75 * scale;
}

/** Proceso completo: elige los fotogramas más nítidos, los alinea con el mejor y los fusiona. */
export function superResolveBurst(
  frames: readonly Uint8Array[],
  size: number,
  options: SuperResolutionOptions = defaultSuperResolutionOptions,
): SuperResolutionResult {
  if (frames.length === 0) throw new Error('No hay fotogramas para fusionar');
  const sharpnessScores = frames.map((framePixels) => measureCropSharpness(framePixels, size));
  const rankedFrameIndices = frames
    .map((_framePixels, frameIndex) => frameIndex)
    .sort((firstIndex, secondIndex) => sharpnessScores[secondIndex]! - sharpnessScores[firstIndex]!);
  const usedFrameCount = Math.max(1, Math.round(frames.length * options.keptFraction));
  const usedFrames = rankedFrameIndices.slice(0, usedFrameCount).map((frameIndex) => frames[frameIndex]!);

  const referenceFrame = usedFrames[0]!;
  const referenceLuminance = computeLuminance(referenceFrame, size);
  const referenceMean = meanOf(referenceLuminance);
  const alignFrame = createFrameAligner(referenceLuminance, size, options.maximumShiftPixels);
  const frameOffsets: FrameOffset[] = [{ offsetX: 0, offsetY: 0 }];
  const robustnessMaps: (Float32Array | null)[] = [null];
  for (const framePixels of usedFrames.slice(1)) {
    const matchedLuminance = matchBrightness(computeLuminance(framePixels, size), referenceMean);
    const frameOffset = alignFrame(matchedLuminance);
    frameOffsets.push(frameOffset);
    robustnessMaps.push(computeRobustnessMap(referenceLuminance, matchedLuminance, size, frameOffset));
  }

  const shiftMagnitudes = frameOffsets.slice(1).map(({ offsetX, offsetY }) => Math.hypot(offsetX, offsetY));
  return {
    image: mergeFramesToFinerGrid(usedFrames, frameOffsets, robustnessMaps, size, {
      scale: options.scale,
      kernelSigmaPixels: kernelSigmaForFrameCount(usedFrameCount),
    }),
    singleFrameImage: upscaleFrameBilinear(referenceFrame, size, options.scale),
    usedFrameCount,
    referenceFrameIndex: rankedFrameIndices[0]!,
    frameOffsets,
    meanShiftPixels:
      shiftMagnitudes.length > 0
        ? shiftMagnitudes.reduce((shiftSum, shiftMagnitude) => shiftSum + shiftMagnitude, 0) / shiftMagnitudes.length
        : 0,
  };
}
