/**
 * Imagen de un solo canal (luminancia) en coma flotante y las operaciones básicas que comparten
 * el ajuste del disco lunar, la imagen afortunada y la luz cenicienta.
 *
 * Convenio de coordenadas: el centro del píxel (columna, fila) está en (x, y) = (columna, fila).
 * Módulo puro: sin React ni React Native.
 */

export interface GrayImage {
  width: number;
  height: number;
  /** Fila a fila, `width × height` valores. */
  values: Float32Array;
}

export function createGrayImage(width: number, height: number, values?: Float32Array): GrayImage {
  if (values && values.length !== width * height) throw new Error('El tamaño de los datos no coincide con la imagen');
  return { width, height, values: values ?? new Float32Array(width * height) };
}

/** Luminancia de una imagen RGB de 8 bits entrelazada (3 bytes por píxel). */
export function grayImageFromRgb(rgbPixels: Uint8Array, width: number, height: number): GrayImage {
  const values = new Float32Array(width * height);
  for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
    const pixelOffset = pixelIndex * 3;
    values[pixelIndex] =
      0.299 * rgbPixels[pixelOffset]! + 0.587 * rgbPixels[pixelOffset + 1]! + 0.114 * rgbPixels[pixelOffset + 2]!;
  }
  return { width, height, values };
}

/** Valor interpolado bilinealmente en (x, y); fuera de la imagen se repite el borde. */
export function sampleBilinear(image: GrayImage, positionX: number, positionY: number): number {
  const { width, height, values } = image;
  const clampedX = positionX < 0 ? 0 : positionX > width - 1 ? width - 1 : positionX;
  const clampedY = positionY < 0 ? 0 : positionY > height - 1 ? height - 1 : positionY;
  const leftColumn = Math.min(width - 2, Math.floor(clampedX));
  const topRow = Math.min(height - 2, Math.floor(clampedY));
  if (leftColumn < 0 || topRow < 0) return values[Math.round(clampedY) * width + Math.round(clampedX)]!;
  const horizontalWeight = clampedX - leftColumn;
  const verticalWeight = clampedY - topRow;
  const topLeftIndex = topRow * width + leftColumn;
  const topValue = values[topLeftIndex]! + horizontalWeight * (values[topLeftIndex + 1]! - values[topLeftIndex]!);
  const bottomLeftIndex = topLeftIndex + width;
  const bottomValue =
    values[bottomLeftIndex]! + horizontalWeight * (values[bottomLeftIndex + 1]! - values[bottomLeftIndex]!);
  return topValue + verticalWeight * (bottomValue - topValue);
}

/** Convolución separable con un núcleo simétrico impar; los bordes se repiten. */
export function convolveSeparable(image: GrayImage, kernelWeights: Float32Array, holeSpacing = 1): GrayImage {
  const { width, height, values } = image;
  const kernelRadius = (kernelWeights.length - 1) / 2;
  const horizontalPass = new Float32Array(width * height);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const rowStart = rowIndex * width;
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      let weightedSum = 0;
      for (let kernelIndex = -kernelRadius; kernelIndex <= kernelRadius; kernelIndex++) {
        const sourceColumn = Math.min(width - 1, Math.max(0, columnIndex + kernelIndex * holeSpacing));
        weightedSum += kernelWeights[kernelIndex + kernelRadius]! * values[rowStart + sourceColumn]!;
      }
      horizontalPass[rowStart + columnIndex] = weightedSum;
    }
  }
  const outputValues = new Float32Array(width * height);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      let weightedSum = 0;
      for (let kernelIndex = -kernelRadius; kernelIndex <= kernelRadius; kernelIndex++) {
        const sourceRow = Math.min(height - 1, Math.max(0, rowIndex + kernelIndex * holeSpacing));
        weightedSum += kernelWeights[kernelIndex + kernelRadius]! * horizontalPass[sourceRow * width + columnIndex]!;
      }
      outputValues[rowIndex * width + columnIndex] = weightedSum;
    }
  }
  return { width, height, values: outputValues };
}

/** Desenfoque gaussiano separable. */
export function gaussianBlurGray(image: GrayImage, sigmaPixels: number): GrayImage {
  if (sigmaPixels <= 0) return { ...image, values: image.values.slice() };
  const kernelRadius = Math.max(1, Math.ceil(sigmaPixels * 3));
  const kernelWeights = new Float32Array(2 * kernelRadius + 1);
  let kernelSum = 0;
  for (let kernelIndex = -kernelRadius; kernelIndex <= kernelRadius; kernelIndex++) {
    const weight = Math.exp(-(kernelIndex * kernelIndex) / (2 * sigmaPixels * sigmaPixels));
    kernelWeights[kernelIndex + kernelRadius] = weight;
    kernelSum += weight;
  }
  for (let kernelIndex = 0; kernelIndex < kernelWeights.length; kernelIndex++) {
    kernelWeights[kernelIndex] = kernelWeights[kernelIndex]! / kernelSum;
  }
  return convolveSeparable(image, kernelWeights);
}

/** Percentil (0-100) de los valores, por ordenación de una muestra de hasta ~20 000 valores. */
export function percentileOfValues(values: Float32Array, percentile: number): number {
  if (values.length === 0) return 0;
  const sampleStride = Math.max(1, Math.floor(values.length / 20_000));
  const sampledValues: number[] = [];
  for (let valueIndex = 0; valueIndex < values.length; valueIndex += sampleStride) sampledValues.push(values[valueIndex]!);
  sampledValues.sort((first, second) => first - second);
  const position = Math.min(sampledValues.length - 1, Math.max(0, Math.round((percentile / 100) * (sampledValues.length - 1))));
  return sampledValues[position]!;
}

export function meanOfValues(values: Float32Array): number {
  let valueSum = 0;
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) valueSum += values[valueIndex]!;
  return values.length > 0 ? valueSum / values.length : 0;
}

/** Generador pseudoaleatorio con semilla (mulberry32), para resultados repetibles. */
export function createSeededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
