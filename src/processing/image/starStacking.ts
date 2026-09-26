/**
 * Apilado de fotos de estrellas y trazos de estrellas.
 *
 * Apilado (un fotograma de 185 ms apenas muestra las estrellas más brillantes):
 *  1. Estrellas de cada fotograma (`starDetection`).
 *  2. Referencia: el fotograma con más estrellas (el más nítido y transparente).
 *  3. Rotación + traslación de cada fotograma respecto a la referencia (`starFieldAlignment`):
 *     el cielo gira alrededor del polo mientras el móvil está quieto.
 *  4. Remuestreo bilineal a la geometría de la referencia y media recortada (sigma-clipping) en
 *     dos pasadas, como `SigmaClippedAccumulator` de `luckyImaging` pero contando en cada píxel
 *     solo los fotogramas que lo cubren (al girar, los bordes quedan fuera de algunas fotos):
 *     desaparecen los píxeles calientes (se mueven respecto al cielo), los aviones y los
 *     satélites. El ruido baja como 1/√N.
 *  5. Resta del gradiente del cielo (`skyBackground`) y estirado asinh.
 *  6. Estrellas detectadas en el apilado y en la referencia sola, para compararlas.
 *
 * Trazos: sin alinear, el máximo de cada píxel de todos los fotogramas. Entre dos fotos queda un
 * hueco (el tiempo de guardar la foto); con «rellenar huecos» se mide el giro entre fotos
 * consecutivas y se añaden copias intermedias de la foto nueva movidas una fracción de ese giro.
 * El paisaje también se mueve esa fracción (un píxel o dos), algo que apenas se nota.
 *
 * Módulo puro: sin React ni React Native.
 */
import {
  alignStarFields,
  applyRigidTransform,
  interpolateRigidTransform,
  invertRigidTransform,
  maximumDisplacementInImage,
  type RigidTransform,
  type StarFieldAlignment,
} from '../astronomy/starFieldAlignment';

import type { GrayImage } from './grayImage';
import type { FrameSource } from './luckyImaging';
import { asinhStretchToBytes, type AsinhStretchParameters, automaticAsinhStretch, subtractSkyBackground } from './skyBackground';
import { type DetectedStar, detectStars, type StarDetectionOptions } from './starDetection';

// ---------------------------------------------------------------------------------------------
// Remuestreo con una transformación rígida
// ---------------------------------------------------------------------------------------------

/**
 * Coeficientes de la inversa: la posición de origen del píxel de salida (x, y) es
 * (cos·x − sen·y + tx, sen·x + cos·y + ty). La transformación dada lleva la fuente a la salida.
 * Los bucles van escritos en línea (sin una función por píxel): en Hermes se nota.
 */
function outputToSourceCoefficients(sourceToOutput: RigidTransform) {
  const outputToSource = invertRigidTransform(sourceToOutput);
  return {
    cosine: Math.cos(outputToSource.rotationRadians),
    sine: Math.sin(outputToSource.rotationRadians),
    translationX: outputToSource.translationX,
    translationY: outputToSource.translationY,
  };
}

/**
 * Fotograma remuestreado a la geometría de la referencia. Fuera de la foto original se pone
 * `fillValue` (NaN para que el apilado no lo cuente).
 */
export function warpGrayImageRigid(source: GrayImage, sourceToOutput: RigidTransform, fillValue: number): GrayImage {
  const { width, height, values } = source;
  const outputValues = new Float32Array(width * height);
  const lastColumn = width - 1;
  const lastRow = height - 1;
  const { cosine, sine, translationX, translationY } = outputToSourceCoefficients(sourceToOutput);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    let sourceX = -sine * rowIndex + translationX;
    let sourceY = cosine * rowIndex + translationY;
    const rowStart = rowIndex * width;
    for (let columnIndex = 0; columnIndex < width; columnIndex++, sourceX += cosine, sourceY += sine) {
      const outputIndex = rowStart + columnIndex;
      if (sourceX < 0 || sourceY < 0 || sourceX > lastColumn || sourceY > lastRow) {
        outputValues[outputIndex] = fillValue;
        continue;
      }
      const leftColumn = sourceX >= lastColumn ? lastColumn - 1 : Math.floor(sourceX);
      const topRow = sourceY >= lastRow ? lastRow - 1 : Math.floor(sourceY);
      const horizontalWeight = sourceX - leftColumn;
      const verticalWeight = sourceY - topRow;
      const topLeftIndex = topRow * width + leftColumn;
      const topValue = values[topLeftIndex]! + horizontalWeight * (values[topLeftIndex + 1]! - values[topLeftIndex]!);
      const bottomValue =
        values[topLeftIndex + width]! + horizontalWeight * (values[topLeftIndex + width + 1]! - values[topLeftIndex + width]!);
      outputValues[outputIndex] = topValue + verticalWeight * (bottomValue - topValue);
    }
  }
  return { width, height, values: outputValues };
}

/**
 * Máximo por píxel entre `accumulator` y la imagen de bytes entrelazados (`channelCount` canales)
 * remuestreada con la transformación (sin nada fuera de la foto).
 */
export function maximumOfWarpedBytesInto(
  accumulator: Uint8Array,
  sourceBytes: Uint8Array,
  width: number,
  height: number,
  channelCount: number,
  sourceToOutput: RigidTransform,
): void {
  const lastColumn = width - 1;
  const lastRow = height - 1;
  const rowStride = width * channelCount;
  const { cosine, sine, translationX, translationY } = outputToSourceCoefficients(sourceToOutput);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    let sourceX = -sine * rowIndex + translationX;
    let sourceY = cosine * rowIndex + translationY;
    for (let columnIndex = 0; columnIndex < width; columnIndex++, sourceX += cosine, sourceY += sine) {
      if (sourceX < 0 || sourceY < 0 || sourceX > lastColumn || sourceY > lastRow) continue;
      const leftColumn = sourceX >= lastColumn ? lastColumn - 1 : Math.floor(sourceX);
      const topRow = sourceY >= lastRow ? lastRow - 1 : Math.floor(sourceY);
      const horizontalWeight = sourceX - leftColumn;
      const verticalWeight = sourceY - topRow;
      const topLeftOffset = topRow * rowStride + leftColumn * channelCount;
      const outputOffset = (rowIndex * width + columnIndex) * channelCount;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        const topLeftValue = sourceBytes[topLeftOffset + channelIndex]!;
        const topRightValue = sourceBytes[topLeftOffset + channelCount + channelIndex]!;
        const bottomLeftValue = sourceBytes[topLeftOffset + rowStride + channelIndex]!;
        const bottomRightValue = sourceBytes[topLeftOffset + rowStride + channelCount + channelIndex]!;
        const topValue = topLeftValue + horizontalWeight * (topRightValue - topLeftValue);
        const bottomValue = bottomLeftValue + horizontalWeight * (bottomRightValue - bottomLeftValue);
        const interpolatedValue = Math.round(topValue + verticalWeight * (bottomValue - topValue));
        if (interpolatedValue > accumulator[outputOffset + channelIndex]!) accumulator[outputOffset + channelIndex] = interpolatedValue;
      }
    }
  }
}

/** Luminancia de bytes RGB entrelazados (o copia si ya es de un canal). */
export function grayImageFromInterleavedBytes(pixelBytes: Uint8Array, width: number, height: number, channelCount: number): GrayImage {
  const values = new Float32Array(width * height);
  if (channelCount === 1) {
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) values[pixelIndex] = pixelBytes[pixelIndex]!;
  } else {
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      const pixelOffset = pixelIndex * channelCount;
      values[pixelIndex] =
        0.299 * pixelBytes[pixelOffset]! + 0.587 * pixelBytes[pixelOffset + 1]! + 0.114 * pixelBytes[pixelOffset + 2]!;
    }
  }
  return { width, height, values };
}

// ---------------------------------------------------------------------------------------------
// Apilado
// ---------------------------------------------------------------------------------------------

export interface StarStackOptions {
  /** κ del recorte de la media. */
  clippingKappa: number;
  /** σ mínima del recorte, en niveles (con 8 bits el ruido nunca baja de ~0,3). */
  minimumClippingSigma: number;
  detection: Partial<StarDetectionOptions>;
  /** Grado del polinomio del fondo del cielo. */
  backgroundDegree: number;
}

export const defaultStarStackOptions: StarStackOptions = {
  clippingKappa: 2.5,
  minimumClippingSigma: 0.5,
  detection: {},
  backgroundDegree: 2,
};

export type StarStackPhase = 'detecting' | 'firstPass' | 'secondPass' | 'finishing';

export interface StarStackProgress {
  phase: StarStackPhase;
  completedCount: number;
  totalCount: number;
}

export interface StackedFrameInfo {
  detectedStarCount: number;
  /** null: no se pudo alinear (nublado, movido) y no entra en el apilado. */
  alignment: StarFieldAlignment | null;
}

export interface ProcessedStarImage {
  /** Imagen con el fondo restado (cielo ≈ 0). */
  flattenedImage: GrayImage;
  stars: DetectedStar[];
  backgroundNoise: number;
  gradientRangeLevels: number;
  /** Bytes 0-255 estirados con asinh (mismos parámetros en el apilado y en el suelto). */
  stretchedBytes: Uint8Array;
}

export interface StarStackResult {
  width: number;
  height: number;
  referenceFrameIndex: number;
  frames: StackedFrameInfo[];
  stackedFrameCount: number;
  /** Fracción de muestras descartadas por el recorte. */
  rejectedSampleFraction: number;
  /** Mayor giro de un fotograma respecto a la referencia, en grados. */
  largestRotationDegrees: number;
  /** Mayor desplazamiento del centro de la imagen respecto a la referencia, en píxeles. */
  largestCenterShiftPixels: number;
  stretch: AsinhStretchParameters;
  stacked: ProcessedStarImage;
  singleFrame: ProcessedStarImage;
}

/**
 * Media recortada en dos pasadas que ignora los NaN (zonas que un fotograma no cubre). Primera
 * pasada: media y varianza (Welford); segunda: solo las muestras a menos de κ·σ de la media.
 */
export class CoverageAwareClippedStack {
  private readonly runningMean: Float64Array;
  private readonly runningSquaredDeviation: Float64Array;
  private readonly firstPassCounts: Uint16Array;
  private readonly clippedSum: Float64Array;
  private readonly clippedCounts: Uint16Array;
  private secondPassSampleCount = 0;
  private rejectedSampleCount = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly clippingKappa: number,
    private readonly minimumSigma: number,
  ) {
    const pixelCount = width * height;
    this.runningMean = new Float64Array(pixelCount);
    this.runningSquaredDeviation = new Float64Array(pixelCount);
    this.firstPassCounts = new Uint16Array(pixelCount);
    this.clippedSum = new Float64Array(pixelCount);
    this.clippedCounts = new Uint16Array(pixelCount);
  }

  addToFirstPass(frame: GrayImage): void {
    const { values } = frame;
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      const value = values[pixelIndex]!;
      if (value !== value) continue; // NaN: fuera del fotograma.
      const sampleCount = this.firstPassCounts[pixelIndex]! + 1;
      this.firstPassCounts[pixelIndex] = sampleCount;
      const previousMean = this.runningMean[pixelIndex]!;
      const updatedMean = previousMean + (value - previousMean) / sampleCount;
      this.runningMean[pixelIndex] = updatedMean;
      this.runningSquaredDeviation[pixelIndex] = this.runningSquaredDeviation[pixelIndex]! + (value - previousMean) * (value - updatedMean);
    }
  }

  addToSecondPass(frame: GrayImage): void {
    const { values } = frame;
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      const value = values[pixelIndex]!;
      if (value !== value) continue;
      const sampleCount = this.firstPassCounts[pixelIndex]!;
      const sigma = Math.max(this.minimumSigma, Math.sqrt(this.runningSquaredDeviation[pixelIndex]! / Math.max(1, sampleCount)));
      this.secondPassSampleCount++;
      if (Math.abs(value - this.runningMean[pixelIndex]!) <= this.clippingKappa * sigma) {
        this.clippedSum[pixelIndex] = this.clippedSum[pixelIndex]! + value;
        this.clippedCounts[pixelIndex] = this.clippedCounts[pixelIndex]! + 1;
      } else {
        this.rejectedSampleCount++;
      }
    }
  }

  clippedMeanImage(): GrayImage {
    const values = new Float32Array(this.width * this.height);
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      const clippedCount = this.clippedCounts[pixelIndex]!;
      values[pixelIndex] = clippedCount > 0 ? this.clippedSum[pixelIndex]! / clippedCount : this.runningMean[pixelIndex]!;
    }
    return { width: this.width, height: this.height, values };
  }

  rejectedFraction(): number {
    return this.secondPassSampleCount > 0 ? this.rejectedSampleCount / this.secondPassSampleCount : 0;
  }
}

function flattenAndDetect(image: GrayImage, options: StarStackOptions) {
  const backgroundSubtraction = subtractSkyBackground(image, { degree: options.backgroundDegree });
  const stars = detectStars(backgroundSubtraction.flattenedImage, options.detection);
  return { ...backgroundSubtraction, stars };
}

/**
 * Apila los fotogramas de `frameSource` (todos del mismo tamaño). `yieldToInterface` se espera
 * entre fotograma y fotograma para que la interfaz pueda pintar el progreso.
 */
export async function stackStarFrames(
  frameSource: FrameSource,
  stackOptions: Partial<StarStackOptions> = {},
  onProgress?: (progress: StarStackProgress) => void,
  yieldToInterface?: () => Promise<void>,
): Promise<StarStackResult> {
  const options = { ...defaultStarStackOptions, ...stackOptions };
  const { frameCount } = frameSource;
  if (frameCount === 0) throw new Error('No hay fotogramas que apilar');

  // 1. Estrellas de cada fotograma.
  const starsPerFrame: DetectedStar[][] = [];
  let width = 0;
  let height = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    onProgress?.({ phase: 'detecting', completedCount: frameIndex, totalCount: frameCount });
    await yieldToInterface?.();
    const frame = frameSource.loadFrame(frameIndex);
    if (frameIndex === 0) {
      width = frame.width;
      height = frame.height;
    } else if (frame.width !== width || frame.height !== height) {
      throw new Error('Los fotogramas no tienen el mismo tamaño');
    }
    starsPerFrame.push(detectStars(frame, options.detection));
  }

  // 2. Referencia: la que más estrellas tiene.
  let referenceFrameIndex = 0;
  starsPerFrame.forEach((frameStars, frameIndex) => {
    if (frameStars.length > starsPerFrame[referenceFrameIndex]!.length) referenceFrameIndex = frameIndex;
  });
  const referenceStars = starsPerFrame[referenceFrameIndex]!;

  // 3. Alineado de cada fotograma con la referencia.
  const imageCenter = { x: (width - 1) / 2, y: (height - 1) / 2 };
  let largestRotationDegrees = 0;
  let largestCenterShiftPixels = 0;
  const frames: StackedFrameInfo[] = starsPerFrame.map((frameStars, frameIndex) => {
    const alignment: StarFieldAlignment | null =
      frameIndex === referenceFrameIndex
        ? {
            transform: { rotationRadians: 0, translationX: 0, translationY: 0 },
            matchedStarCount: frameStars.length,
            rmsResidualPixels: 0,
          }
        : alignStarFields(referenceStars, frameStars);
    if (alignment) {
      largestRotationDegrees = Math.max(largestRotationDegrees, Math.abs((alignment.transform.rotationRadians * 180) / Math.PI));
      const movedCenter = applyRigidTransform(alignment.transform, imageCenter);
      largestCenterShiftPixels = Math.max(largestCenterShiftPixels, Math.hypot(movedCenter.x - imageCenter.x, movedCenter.y - imageCenter.y));
    }
    return { detectedStarCount: frameStars.length, alignment };
  });
  const alignedFrameIndices = frames.flatMap((frameInfo, frameIndex) => (frameInfo.alignment ? [frameIndex] : []));

  // 4. Media recortada en dos pasadas (se remuestrea dos veces para no guardar los flotantes).
  const accumulator = new CoverageAwareClippedStack(width, height, options.clippingKappa, options.minimumClippingSigma);
  for (const passPhase of ['firstPass', 'secondPass'] as const) {
    for (let alignedIndex = 0; alignedIndex < alignedFrameIndices.length; alignedIndex++) {
      onProgress?.({ phase: passPhase, completedCount: alignedIndex, totalCount: alignedFrameIndices.length });
      await yieldToInterface?.();
      const frameIndex = alignedFrameIndices[alignedIndex]!;
      const frame = frameSource.loadFrame(frameIndex);
      const warpedFrame =
        frameIndex === referenceFrameIndex ? frame : warpGrayImageRigid(frame, frames[frameIndex]!.alignment!.transform, Number.NaN);
      if (passPhase === 'firstPass') accumulator.addToFirstPass(warpedFrame);
      else accumulator.addToSecondPass(warpedFrame);
    }
  }
  onProgress?.({ phase: 'finishing', completedCount: 0, totalCount: 1 });
  await yieldToInterface?.();
  const stackedImage = alignedFrameIndices.length > 1 ? accumulator.clippedMeanImage() : frameSource.loadFrame(referenceFrameIndex);

  // 5-6. Fondo, estrellas y estirado (los parámetros del apilado valen para los dos: así el
  // fotograma suelto se ve con su ruido real al lado del apilado).
  const stackedProcessing = flattenAndDetect(stackedImage, options);
  const singleProcessing = flattenAndDetect(frameSource.loadFrame(referenceFrameIndex), options);
  const stretch = automaticAsinhStretch(stackedProcessing.flattenedImage, stackedProcessing.backgroundNoise);
  const toProcessedImage = (processing: ReturnType<typeof flattenAndDetect>): ProcessedStarImage => ({
    flattenedImage: processing.flattenedImage,
    stars: processing.stars,
    backgroundNoise: processing.backgroundNoise,
    gradientRangeLevels: processing.gradientRangeLevels,
    stretchedBytes: asinhStretchToBytes(processing.flattenedImage, stretch),
  });

  return {
    width,
    height,
    referenceFrameIndex,
    frames,
    stackedFrameCount: alignedFrameIndices.length,
    rejectedSampleFraction: alignedFrameIndices.length > 1 ? accumulator.rejectedFraction() : 0,
    largestRotationDegrees,
    largestCenterShiftPixels,
    stretch,
    stacked: toProcessedImage(stackedProcessing),
    singleFrame: toProcessedImage(singleProcessing),
  };
}

// ---------------------------------------------------------------------------------------------
// Trazos de estrellas
// ---------------------------------------------------------------------------------------------

export interface StarTrailOptions {
  /** Rellenar los huecos entre fotos con copias intermedias. */
  fillGaps: boolean;
  /** Paso máximo entre copias intermedias, en píxeles de desplazamiento. */
  fillStepPixels: number;
  /** Tope de copias intermedias entre dos fotos. */
  maximumFillCopies: number;
  detection: Partial<StarDetectionOptions>;
}

export const defaultStarTrailOptions: StarTrailOptions = {
  fillGaps: true,
  fillStepPixels: 0.75,
  maximumFillCopies: 24,
  detection: { maximumStarCount: 200 },
};

/**
 * Trazos por máximo de cada píxel, fotograma a fotograma (memoria fija: un plano de máximos y las
 * estrellas de la foto anterior). Admite gris (1 canal) o RGB entrelazado (3).
 */
export class StarTrailAccumulator {
  private readonly maximumBytes: Uint8Array;
  private readonly options: StarTrailOptions;
  private previousStars: DetectedStar[] | null = null;
  private addedFrameCount = 0;
  private insertedCopyCount = 0;
  private unalignedGapCount = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly channelCount: 1 | 3,
    trailOptions: Partial<StarTrailOptions> = {},
  ) {
    this.options = { ...defaultStarTrailOptions, ...trailOptions };
    this.maximumBytes = new Uint8Array(width * height * channelCount);
  }

  addFrame(pixelBytes: Uint8Array): void {
    if (pixelBytes.length !== this.maximumBytes.length) throw new Error('El fotograma no tiene el tamaño de los trazos');
    if (this.options.fillGaps) {
      const currentStars = detectStars(
        grayImageFromInterleavedBytes(pixelBytes, this.width, this.height, this.channelCount),
        this.options.detection,
      );
      if (this.previousStars) {
        // Lleva la foto nueva a la anterior; las copias intermedias van de una a otra.
        const alignment = alignStarFields(this.previousStars, currentStars);
        if (alignment) {
          const gapDisplacement = maximumDisplacementInImage(alignment.transform, this.width, this.height);
          const copyCount = Math.min(this.options.maximumFillCopies, Math.ceil(gapDisplacement / this.options.fillStepPixels) - 1);
          for (let copyIndex = 1; copyIndex <= copyCount; copyIndex++) {
            const fraction = copyIndex / (copyCount + 1);
            maximumOfWarpedBytesInto(
              this.maximumBytes,
              pixelBytes,
              this.width,
              this.height,
              this.channelCount,
              interpolateRigidTransform(alignment.transform, fraction),
            );
            this.insertedCopyCount++;
          }
        } else {
          this.unalignedGapCount++;
        }
      }
      this.previousStars = currentStars;
    }
    const { maximumBytes } = this;
    for (let byteIndex = 0; byteIndex < maximumBytes.length; byteIndex++) {
      if (pixelBytes[byteIndex]! > maximumBytes[byteIndex]!) maximumBytes[byteIndex] = pixelBytes[byteIndex]!;
    }
    this.addedFrameCount++;
  }

  /** Imagen de trazos (la misma memoria: cópiala si la vas a guardar mientras sigue sumando). */
  trailBytes(): Uint8Array {
    return this.maximumBytes;
  }

  statistics() {
    return {
      frameCount: this.addedFrameCount,
      insertedCopyCount: this.insertedCopyCount,
      unalignedGapCount: this.unalignedGapCount,
    };
  }
}

/** Trazos de una lista de fotogramas en gris (atajo para pruebas y ráfagas cortas). */
export function starTrailsFromGrayFrames(frames: readonly GrayImage[], trailOptions: Partial<StarTrailOptions> = {}): Uint8Array {
  const firstFrame = frames[0];
  if (!firstFrame) return new Uint8Array(0);
  const trailAccumulator = new StarTrailAccumulator(firstFrame.width, firstFrame.height, 1, trailOptions);
  for (const frame of frames) {
    const frameBytes = new Uint8Array(frame.values.length);
    for (let pixelIndex = 0; pixelIndex < frameBytes.length; pixelIndex++) {
      frameBytes[pixelIndex] = Math.max(0, Math.min(255, Math.round(frame.values[pixelIndex]!)));
    }
    trailAccumulator.addFrame(frameBytes);
  }
  return trailAccumulator.trailBytes();
}
