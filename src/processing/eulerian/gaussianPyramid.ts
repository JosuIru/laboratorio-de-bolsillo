/**
 * Reducción espacial para la amplificación euleriana (Wu et al., 2012): del fotograma de la
 * cámara a una rejilla pequeña y, de ahí, a los niveles de una pirámide gaussiana.
 *
 * Todo son worklets sin estado: se ejecutan en el hilo de la cámara, fotograma a fotograma.
 * Las imágenes son `Float32Array` con los canales intercalados (RGB: 3; luminancia: 1).
 */

/** Imagen pequeña en coma flotante (0-255), con los canales intercalados. */
export interface GridImage {
  pixels: Float32Array;
  width: number;
  height: number;
  channelCount: number;
}

/**
 * Promedia bloques del fotograma para obtener una rejilla RGB de `outputWidth × outputHeight`.
 * `sampleStride` lee uno de cada N píxeles (y filas) dentro de cada bloque: con 2, se leen la
 * cuarta parte, que para promediar ruido sigue siendo de sobra y cuesta cuatro veces menos.
 * `isBgra` indica que el primer byte de cada píxel es el azul.
 */
export function downsampleFrameByBlockAverage(
  framePixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  bytesPerPixel: number,
  isBgra: boolean,
  outputWidth: number,
  outputHeight: number,
  sampleStride: number,
): GridImage {
  'worklet';
  const outputPixels = new Float32Array(outputWidth * outputHeight * 3);
  const redOffset = isBgra ? 2 : 0;
  const blueOffset = isBgra ? 0 : 2;
  for (let outputRow = 0; outputRow < outputHeight; outputRow++) {
    const firstFrameRow = Math.floor((outputRow * frameHeight) / outputHeight);
    const endFrameRow = Math.max(firstFrameRow + 1, Math.floor(((outputRow + 1) * frameHeight) / outputHeight));
    for (let outputColumn = 0; outputColumn < outputWidth; outputColumn++) {
      const firstFrameColumn = Math.floor((outputColumn * frameWidth) / outputWidth);
      const endFrameColumn = Math.max(
        firstFrameColumn + 1,
        Math.floor(((outputColumn + 1) * frameWidth) / outputWidth),
      );
      let redSum = 0;
      let greenSum = 0;
      let blueSum = 0;
      let sampleCount = 0;
      for (let frameRow = firstFrameRow; frameRow < endFrameRow; frameRow += sampleStride) {
        const rowStart = frameRow * bytesPerRow;
        for (let frameColumn = firstFrameColumn; frameColumn < endFrameColumn; frameColumn += sampleStride) {
          const pixelStart = rowStart + frameColumn * bytesPerPixel;
          redSum += framePixels[pixelStart + redOffset]!;
          greenSum += framePixels[pixelStart + 1]!;
          blueSum += framePixels[pixelStart + blueOffset]!;
          sampleCount++;
        }
      }
      const outputStart = (outputRow * outputWidth + outputColumn) * 3;
      outputPixels[outputStart] = redSum / sampleCount;
      outputPixels[outputStart + 1] = greenSum / sampleCount;
      outputPixels[outputStart + 2] = blueSum / sampleCount;
    }
  }
  return { pixels: outputPixels, width: outputWidth, height: outputHeight, channelCount: 3 };
}

/** Pesos binomiales 1-4-6-4-1 (/16): la aproximación clásica de la gaussiana de Burt y Adelson. */
const binomialWeights = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

function clampIndex(index: number, size: number): number {
  'worklet';
  return index < 0 ? 0 : index >= size ? size - 1 : index;
}

/**
 * Un paso de la pirámide gaussiana (REDUCE): suaviza con el núcleo binomial 5×5 separable y se
 * queda con uno de cada dos píxeles en cada eje. Los bordes se replican.
 */
export function reduceGaussianLevel(inputImage: GridImage): GridImage {
  'worklet';
  const { pixels: inputPixels, width: inputWidth, height: inputHeight, channelCount } = inputImage;
  const outputWidth = Math.max(1, Math.floor(inputWidth / 2));
  const outputHeight = Math.max(1, Math.floor(inputHeight / 2));

  // Primero en horizontal (solo las columnas que se conservan), después en vertical.
  const horizontallyBlurred = new Float32Array(outputWidth * inputHeight * channelCount);
  for (let inputRow = 0; inputRow < inputHeight; inputRow++) {
    for (let outputColumn = 0; outputColumn < outputWidth; outputColumn++) {
      const centerColumn = outputColumn * 2;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        let weightedSum = 0;
        for (let tapIndex = 0; tapIndex < 5; tapIndex++) {
          const sourceColumn = clampIndex(centerColumn + tapIndex - 2, inputWidth);
          weightedSum +=
            binomialWeights[tapIndex]! * inputPixels[(inputRow * inputWidth + sourceColumn) * channelCount + channelIndex]!;
        }
        horizontallyBlurred[(inputRow * outputWidth + outputColumn) * channelCount + channelIndex] = weightedSum;
      }
    }
  }

  const outputPixels = new Float32Array(outputWidth * outputHeight * channelCount);
  for (let outputRow = 0; outputRow < outputHeight; outputRow++) {
    const centerRow = outputRow * 2;
    for (let outputColumn = 0; outputColumn < outputWidth; outputColumn++) {
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        let weightedSum = 0;
        for (let tapIndex = 0; tapIndex < 5; tapIndex++) {
          const sourceRow = clampIndex(centerRow + tapIndex - 2, inputHeight);
          weightedSum +=
            binomialWeights[tapIndex]! *
            horizontallyBlurred[(sourceRow * outputWidth + outputColumn) * channelCount + channelIndex]!;
        }
        outputPixels[(outputRow * outputWidth + outputColumn) * channelCount + channelIndex] = weightedSum;
      }
    }
  }
  return { pixels: outputPixels, width: outputWidth, height: outputHeight, channelCount };
}

/** Aplica `reductionCount` pasos REDUCE seguidos (0 devuelve la misma imagen). */
export function reduceGaussianLevels(inputImage: GridImage, reductionCount: number): GridImage {
  'worklet';
  let currentImage = inputImage;
  for (let reductionIndex = 0; reductionIndex < reductionCount; reductionIndex++) {
    currentImage = reduceGaussianLevel(currentImage);
  }
  return currentImage;
}

/** Luminancia (Rec. 601) de una imagen RGB: una imagen de un solo canal. */
export function convertToLuminance(rgbImage: GridImage): GridImage {
  'worklet';
  const pixelCount = rgbImage.width * rgbImage.height;
  const luminancePixels = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    luminancePixels[pixelIndex] =
      0.299 * rgbImage.pixels[pixelIndex * 3]! +
      0.587 * rgbImage.pixels[pixelIndex * 3 + 1]! +
      0.114 * rgbImage.pixels[pixelIndex * 3 + 2]!;
  }
  return { pixels: luminancePixels, width: rgbImage.width, height: rgbImage.height, channelCount: 1 };
}

/** Convierte una imagen RGB flotante a bytes RGB (para enviarla barata al hilo JS). */
export function convertToRgbBytes(rgbImage: GridImage): Uint8Array {
  'worklet';
  const rgbBytes = new Uint8Array(rgbImage.pixels.length);
  for (let valueIndex = 0; valueIndex < rgbImage.pixels.length; valueIndex++) {
    const roundedValue = Math.round(rgbImage.pixels[valueIndex]!);
    rgbBytes[valueIndex] = roundedValue < 0 ? 0 : roundedValue > 255 ? 255 : roundedValue;
  }
  return rgbBytes;
}

/**
 * Tamaño de la rejilla base para un fotograma: el lado largo mide `longSidePixels` y el corto,
 * lo proporcional, redondeado a múltiplo de 4 para que los dos niveles de la pirámide salgan exactos.
 */
export function chooseBaseGridSize(
  frameWidth: number,
  frameHeight: number,
  longSidePixels: number,
): { gridWidth: number; gridHeight: number } {
  'worklet';
  const shortSidePixels = Math.max(4, Math.round((longSidePixels * Math.min(frameWidth, frameHeight)) / Math.max(frameWidth, frameHeight) / 4) * 4);
  return frameWidth >= frameHeight
    ? { gridWidth: longSidePixels, gridHeight: shortSidePixels }
    : { gridWidth: shortSidePixels, gridHeight: longSidePixels };
}
