/**
 * Modo noche: una ráfaga de fotos con exposición fija, alineadas y promediadas con rechazo de lo
 * que se mueve, reducción de ruido suave y un revelado que aclara la escena sin quemar las luces.
 *
 * 1. Exposición (`planNightModeExposure`): con el móvil apoyado (quieto según el giroscopio) cada
 *    foto puede durar hasta 185 ms con ISO bajo; en la mano, como mucho 1/30 s con ISO alto. El
 *    ruido de cada foto lo quita el promedio de N fotos (÷√N); lo movido no lo arregla nada.
 * 2. Alineado: global (traslación, `createFrameAligner`) y por zonas (giro, obturador, paralaje:
 *    `measureFrameLocalAlignment`), sobre la luminancia algo suavizada, que con ISO alto es muy
 *    ruidosa.
 * 3. Media con rechazo de valores atípicos. Por píxel, con la luminancia alineada (suavizada) de
 *    todas las fotos: primero se descartan las muestras que se salen de la media del resto
 *    («dejando una fuera», que no se deja engañar por la propia muestra atípica); con lo que queda
 *    se calculan una media y una dispersión robustas; al fusionar el color, cada foto aporta solo
 *    donde su luminancia está a menos de κ·σ de esa media. Un coche o una persona que cruza en una
 *    foto desaparecen; lo que está quieto se promedia entero.
 * 4. Reducción de ruido suave (`denoiseNightImage`): encoge el detalle más fino de la luminancia
 *    que es del tamaño del ruido y suaviza el color (el ojo apenas ve detalle en el color).
 * 5. Revelado (`toneMapNightImage`) con el control «Ambiente»: de 0 («parece de noche», oscuro y
 *    algo desaturado) a 1 («como de día»), en luz lineal, con una curva de Reinhard extendida que
 *    lleva la luz más fuerte justo al blanco: las farolas no se queman.
 *
 * Imágenes cuadradas (`size`²), RGB de 8 bits. Módulo puro: sin React ni React Native.
 */

import { estimateFlatAreaNoiseSigma } from './burstDeconvolution';
import { createFrameAligner, type FrameOffset } from './burstSuperResolution';
import { approximateGaussianBlurPlane, smoothWithBinomial3 } from './fastPlaneBlur';
import { type GrayImage, percentileOfValues } from './grayImage';
import {
  defaultLocalAlignmentOptions,
  type DenseDisplacement,
  denseDisplacement,
  measureFrameLocalAlignment,
  warpWithDisplacement,
} from './localBurstAlignment';
import { type DisplacementField, findAlignmentPoints } from './luckyImaging';
import { type FloatRgbImage, measureCropSharpness } from './lunarStacking';

// ---------------------------------------------------------------------------------------------
// Exposición
// ---------------------------------------------------------------------------------------------

export type NightHoldingMode = 'tripod' | 'handheld';

/** Exposición automática actual (misma forma que en `@/core/camera/burstExposure`). */
export interface AutomaticExposure {
  exposureSeconds: number;
  iso: number;
}

export interface NightExposureLimits {
  minimumExposureSeconds: number;
  maximumExposureSeconds: number;
  minimumIso: number;
  maximumIso: number;
}

/** Apoyado: la exposición más larga que admite el móvil del usuario (185 ms). */
export const tripodMaximumExposureSeconds = 0.185;
/** En la mano: más largo que 1/30 s, el pulso mueve cada foto. */
export const handheldMaximumExposureSeconds = 1 / 30;
/**
 * Luz de cada foto respecto a la exposición automática: medio paso menos (×0,7), para que las
 * luces no se saturen en ninguna foto (una luz quemada no la recupera el promedio). Las sombras
 * las aclara el revelado, ya sin ruido.
 */
export const nightExposureBrightnessFactor = 0.7;
export const tripodFrameCount = 10;
export const handheldFrameCount = 16;

export interface NightExposurePlan {
  holdingMode: NightHoldingMode;
  exposureSeconds: number;
  iso: number;
  frameCount: number;
  /** Luz de cada foto respecto a la automática (tiempo × ISO); < 0,7 si el ISO llegó al tope. */
  brightnessRelativeToAutomatic: number;
}

/**
 * Tiempo e ISO de cada foto según cómo se sujete el móvil, con la luz de la exposición automática
 * × `nightExposureBrightnessFactor`. null si la exposición automática no es válida.
 */
export function planNightModeExposure(
  automaticExposure: AutomaticExposure,
  exposureLimits: NightExposureLimits,
  holdingMode: NightHoldingMode,
): NightExposurePlan | null {
  const { exposureSeconds: automaticSeconds, iso: automaticIso } = automaticExposure;
  if (!(automaticSeconds > 0) || !(automaticIso > 0)) return null;
  const { minimumExposureSeconds, maximumExposureSeconds, minimumIso, maximumIso } = exposureLimits;
  const exposureProduct = automaticSeconds * automaticIso * nightExposureBrightnessFactor;
  const longestSeconds = Math.min(
    maximumExposureSeconds,
    holdingMode === 'tripod' ? tripodMaximumExposureSeconds : handheldMaximumExposureSeconds,
  );
  let plannedSeconds = Math.max(minimumExposureSeconds, longestSeconds);
  let plannedIso = exposureProduct / plannedSeconds;
  if (plannedIso < minimumIso) {
    // Hay luz de sobra: ISO mínimo y el tiempo que haga falta.
    plannedIso = minimumIso;
    plannedSeconds = Math.min(longestSeconds, Math.max(minimumExposureSeconds, exposureProduct / minimumIso));
  }
  plannedIso = Math.min(maximumIso, Math.max(minimumIso, plannedIso));
  return {
    holdingMode,
    exposureSeconds: plannedSeconds,
    iso: Math.round(plannedIso),
    frameCount: holdingMode === 'tripod' ? tripodFrameCount : handheldFrameCount,
    brightnessRelativeToAutomatic: (plannedSeconds * Math.round(plannedIso)) / (automaticSeconds * automaticIso),
  };
}

// ---------------------------------------------------------------------------------------------
// Apilado con rechazo
// ---------------------------------------------------------------------------------------------

export interface NightStackOptions {
  useLocalAlignment: boolean;
  /** Mayor desplazamiento entre fotos que se busca (px). */
  maximumShiftPixels: number;
  /** Cuántas desviaciones se toleran antes de rechazar una muestra. */
  clippingKappa: number;
}

export const defaultNightStackOptions: NightStackOptions = {
  useLocalAlignment: true,
  maximumShiftPixels: 48,
  clippingKappa: 3,
};

export interface NightStackTimings {
  globalAlignmentMilliseconds: number;
  localAlignmentMilliseconds: number;
  mergeMilliseconds: number;
  totalMilliseconds: number;
}

export interface NightStackResult {
  /** Promedio con rechazo, en la misma escala que las fotos (0-255, sin revelar). */
  stackedImage: FloatRgbImage;
  /** La foto de referencia sola, para comparar. */
  referenceImage: FloatRgbImage;
  referenceFrameIndex: number;
  usedFrameCount: number;
  /** Fracción de muestras (foto × píxel) rechazadas por atípicas. */
  rejectedFraction: number;
  locallyAlignedFrameCount: number;
  meanShiftPixels: number;
  /** Ruido de la foto sola ÷ ruido del promedio (medido en las zonas lisas). */
  noiseReductionFactor: number;
  timings: NightStackTimings;
}

/** Muestras por canal para las medianas de brillo (una de cada tantas). */
const medianSampleStride = 7;
/** Rechazo de la primera pasada («dejando una fuera»): más permisivo que el final. */
const leaveOneOutKappa = 2.5;

/** Mediana de cada canal (muestreada): ganancias robustas a lo que se mueva en la escena. */
function channelMedians(framePixels: Uint8Array, pixelCount: number): [number, number, number] {
  const channelSamples: number[][] = [[], [], []];
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += medianSampleStride) {
    for (let channelIndex = 0; channelIndex < 3; channelIndex++) channelSamples[channelIndex]!.push(framePixels[pixelIndex * 3 + channelIndex]!);
  }
  return channelSamples.map((samples) => {
    samples.sort((first, second) => first - second);
    return samples[Math.floor(samples.length / 2)] ?? 0;
  }) as [number, number, number];
}

/** Luminancia con ganancias por canal y suavizada dos veces (σ ≈ 1 px): quita casi todo el ruido de píxel. */
function smoothedLuminance(framePixels: Uint8Array, size: number, channelGains: readonly number[]): Float32Array {
  const pixelCount = size * size;
  const luminance = new Float32Array(pixelCount);
  const redWeight = 0.299 * channelGains[0]!;
  const greenWeight = 0.587 * channelGains[1]!;
  const blueWeight = 0.114 * channelGains[2]!;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    luminance[pixelIndex] =
      redWeight * framePixels[pixelIndex * 3]! + greenWeight * framePixels[pixelIndex * 3 + 1]! + blueWeight * framePixels[pixelIndex * 3 + 2]!;
  }
  return smoothWithBinomial3(smoothWithBinomial3(luminance, size, size), size, size);
}

function rgbToFloatImage(framePixels: Uint8Array, size: number): FloatRgbImage {
  return { size, channels: Float32Array.from(framePixels) };
}

function luminanceOfFloatImage(image: FloatRgbImage): Float32Array {
  const pixelCount = image.size * image.size;
  const luminance = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    luminance[pixelIndex] =
      0.299 * image.channels[pixelIndex * 3]! + 0.587 * image.channels[pixelIndex * 3 + 1]! + 0.114 * image.channels[pixelIndex * 3 + 2]!;
  }
  return luminance;
}

/** Miniatura de luminancia: medias por bloques de `blockSide` px (con las ganancias igualadas a la mediana). */
function luminanceThumbnail(framePixels: Uint8Array, size: number, blockSide: number, medians: readonly number[]): Float32Array {
  const blocksPerSide = Math.floor(size / blockSide);
  const thumbnail = new Float32Array(blocksPerSide * blocksPerSide);
  const redWeight = medians[0]! > 0 ? 0.299 / medians[0]! : 0;
  const greenWeight = medians[1]! > 0 ? 0.587 / medians[1]! : 0;
  const blueWeight = medians[2]! > 0 ? 0.114 / medians[2]! : 0;
  for (let rowIndex = 0; rowIndex < blocksPerSide * blockSide; rowIndex++) {
    const blockRowStart = Math.floor(rowIndex / blockSide) * blocksPerSide;
    for (let columnIndex = 0; columnIndex < blocksPerSide * blockSide; columnIndex++) {
      const pixelOffset = (rowIndex * size + columnIndex) * 3;
      const blockIndex = blockRowStart + Math.floor(columnIndex / blockSide);
      thumbnail[blockIndex] =
        thumbnail[blockIndex]! +
        redWeight * framePixels[pixelOffset]! +
        greenWeight * framePixels[pixelOffset + 1]! +
        blueWeight * framePixels[pixelOffset + 2]!;
    }
  }
  return thumbnail;
}

/**
 * Foto de referencia: la más nítida (la menos movida) de entre las que se parecen a la mayoría.
 * Si algo cruza en una foto (un coche con los faros), esa foto se aparta de la mediana de las
 * miniaturas y no se elige: con el objeto en la referencia, el alineado de todas las demás se
 * guiaría por él.
 */
function chooseNightReferenceFrame(frames: readonly Uint8Array[], size: number, frameMedians: readonly number[][]): number {
  const sharpnessScores = frames.map((framePixels) => measureCropSharpness(framePixels, size));
  if (frames.length < 3) return sharpnessScores.indexOf(Math.max(...sharpnessScores));
  const blockSide = Math.max(4, Math.floor(size / 24));
  const thumbnails = frames.map((framePixels, frameIndex) => luminanceThumbnail(framePixels, size, blockSide, frameMedians[frameIndex]!));
  const blockCount = thumbnails[0]!.length;
  const deviations = new Array<number>(frames.length).fill(0);
  const blockValues = new Array<number>(frames.length);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) blockValues[frameIndex] = thumbnails[frameIndex]![blockIndex]!;
    const sortedValues = [...blockValues].sort((first, second) => first - second);
    const blockMedian = sortedValues[Math.floor(sortedValues.length / 2)]!;
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      deviations[frameIndex] = deviations[frameIndex]! + Math.abs(blockValues[frameIndex]! - blockMedian);
    }
  }
  const medianDeviation = [...deviations].sort((first, second) => first - second)[Math.floor(deviations.length / 2)]!;
  let referenceFrameIndex = -1;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    if (deviations[frameIndex]! > 1.25 * medianDeviation) continue;
    if (referenceFrameIndex < 0 || sharpnessScores[frameIndex]! > sharpnessScores[referenceFrameIndex]!) referenceFrameIndex = frameIndex;
  }
  return referenceFrameIndex >= 0 ? referenceFrameIndex : sharpnessScores.indexOf(Math.max(...sharpnessScores));
}

interface FrameAlignment {
  globalOffset: FrameOffset;
  localField: DisplacementField | null;
}

/**
 * Alinea y promedia la ráfaga con rechazo de lo que se mueve. La referencia es la foto más nítida
 * (la menos movida).
 */
export function stackNightBurst(
  frames: readonly Uint8Array[],
  size: number,
  options: NightStackOptions = defaultNightStackOptions,
  now: () => number = Date.now,
): NightStackResult {
  if (frames.length === 0) throw new Error('No hay fotos para apilar');
  const startTime = now();
  const frameCount = frames.length;
  const pixelCount = size * size;

  // Ganancias por canal (medianas: si el balance o la exposición variaron un poco) y referencia.
  const frameMedians = frames.map((framePixels) => channelMedians(framePixels, pixelCount));
  const referenceFrameIndex = chooseNightReferenceFrame(frames, size, frameMedians);
  const referenceMedians = frameMedians[referenceFrameIndex]!;
  const frameChannelGains = frameMedians.map((medians) =>
    medians.map((frameMedian, channelIndex) => (frameMedian > 0 ? referenceMedians[channelIndex]! / frameMedian : 1)),
  );

  // 1. Alineado global y por zonas; se guarda la luminancia alineada (suavizada) de cada foto.
  const globalAlignmentStartTime = now();
  const referenceLuminance = smoothedLuminance(frames[referenceFrameIndex]!, size, frameChannelGains[referenceFrameIndex]!);
  const referenceImage: GrayImage = { width: size, height: size, values: referenceLuminance };
  // En recortes pequeños, una búsqueda muy amplia encuentra coincidencias falsas.
  const alignFrame = createFrameAligner(referenceLuminance, size, Math.min(options.maximumShiftPixels, size / 8));
  const localOptions = defaultLocalAlignmentOptions(size);
  const alignmentPoints =
    options.useLocalAlignment && frameCount > 1
      ? findAlignmentPoints(referenceImage, localOptions.pointSpacingPixels, localOptions.patchRadiusPixels, localOptions.coarseSearchRadiusPixels)
      : [];
  let globalAlignmentMilliseconds = now() - globalAlignmentStartTime;
  let localAlignmentMilliseconds = 0;
  const frameAlignments: FrameAlignment[] = [];
  const alignedLuminances: Uint8Array[] = [];
  const luminanceSum = new Float64Array(pixelCount);
  const luminanceSquaredSum = new Float64Array(pixelCount);
  let locallyAlignedFrameCount = 0;
  let shiftSum = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    let warpedLuminance: Float32Array;
    if (frameIndex === referenceFrameIndex) {
      frameAlignments.push({ globalOffset: { offsetX: 0, offsetY: 0 }, localField: null });
      warpedLuminance = referenceLuminance;
    } else {
      const frameAlignmentStartTime = now();
      const frameLuminance = smoothedLuminance(frames[frameIndex]!, size, frameChannelGains[frameIndex]!);
      const globalOffset = alignFrame(frameLuminance);
      shiftSum += Math.hypot(globalOffset.offsetX, globalOffset.offsetY);
      const localStartTime = now();
      globalAlignmentMilliseconds += localStartTime - frameAlignmentStartTime;
      const frameImage: GrayImage = { width: size, height: size, values: frameLuminance };
      const localAlignment =
        alignmentPoints.length > 0 ? measureFrameLocalAlignment(referenceImage, frameImage, globalOffset, alignmentPoints, localOptions) : null;
      if (localAlignment) locallyAlignedFrameCount++;
      frameAlignments.push({ globalOffset, localField: localAlignment?.field ?? null });
      warpedLuminance = warpWithDisplacement(frameImage, denseDisplacement(size, globalOffset, localAlignment?.field)).values;
      localAlignmentMilliseconds += now() - localStartTime;
    }
    const storedLuminance = new Uint8Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const value = warpedLuminance[pixelIndex]!;
      storedLuminance[pixelIndex] = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
      const storedValue = storedLuminance[pixelIndex]!;
      luminanceSum[pixelIndex] = luminanceSum[pixelIndex]! + storedValue;
      luminanceSquaredSum[pixelIndex] = luminanceSquaredSum[pixelIndex]! + storedValue * storedValue;
    }
    alignedLuminances.push(storedLuminance);
  }

  // 2. Media y dispersión robustas por píxel.
  const mergeStartTime = now();
  const plainSigma = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const plainMean = luminanceSum[pixelIndex]! / frameCount;
    plainSigma[pixelIndex] = Math.sqrt(Math.max(0, luminanceSquaredSum[pixelIndex]! / frameCount - plainMean * plainMean));
  }
  // Suelo de la dispersión: la típica de la imagen (casi toda quieta), para no recortar ruido normal.
  const sigmaFloor = Math.max(1, percentileOfValues(plainSigma, 50));
  const robustMean = new Float32Array(pixelCount);
  const acceptanceThreshold = new Float32Array(pixelCount).fill(Number.POSITIVE_INFINITY);
  if (frameCount >= 3) {
    const keptSum = new Float64Array(pixelCount);
    const keptSquaredSum = new Float64Array(pixelCount);
    const keptCount = new Uint16Array(pixelCount);
    for (const storedLuminance of alignedLuminances) {
      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        const value = storedLuminance[pixelIndex]!;
        const othersMean = (luminanceSum[pixelIndex]! - value) / (frameCount - 1);
        const othersVariance =
          (luminanceSquaredSum[pixelIndex]! - value * value - (frameCount - 1) * othersMean * othersMean) / (frameCount - 2);
        const othersSigma = othersVariance > sigmaFloor * sigmaFloor ? Math.sqrt(othersVariance) : sigmaFloor;
        if (Math.abs(value - othersMean) <= leaveOneOutKappa * othersSigma) {
          keptSum[pixelIndex] = keptSum[pixelIndex]! + value;
          keptSquaredSum[pixelIndex] = keptSquaredSum[pixelIndex]! + value * value;
          keptCount[pixelIndex] = keptCount[pixelIndex]! + 1;
        }
      }
    }
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const sampleCount = keptCount[pixelIndex]!;
      if (sampleCount === 0) {
        robustMean[pixelIndex] = luminanceSum[pixelIndex]! / frameCount;
        continue;
      }
      const mean = keptSum[pixelIndex]! / sampleCount;
      const variance = sampleCount > 1 ? ((keptSquaredSum[pixelIndex]! / sampleCount - mean * mean) * sampleCount) / (sampleCount - 1) : 0;
      robustMean[pixelIndex] = mean;
      acceptanceThreshold[pixelIndex] = options.clippingKappa * Math.max(sigmaFloor, Math.sqrt(Math.max(0, variance)));
    }
  }

  // 3. Fusión del color: cada foto, leída en su posición alineada, solo donde no es atípica.
  const acceptedSums = new Float32Array(pixelCount * 3);
  const acceptedCounts = new Uint16Array(pixelCount);
  const plainSums = new Float32Array(pixelCount * 3);
  let rejectedSampleCount = 0;
  const lastIndex = size - 1;
  const lastTopLeft = size - 2;
  const rowStride = size * 3;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const framePixels = frames[frameIndex]!;
    const [redGain, greenGain, blueGain] = frameChannelGains[frameIndex]! as [number, number, number];
    const storedLuminance = alignedLuminances[frameIndex]!;
    const { globalOffset, localField } = frameAlignments[frameIndex]!;
    const displacement: DenseDisplacement | null =
      frameIndex === referenceFrameIndex ? null : denseDisplacement(size, globalOffset, localField);
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      for (let columnIndex = 0; columnIndex < size; columnIndex++) {
        const pixelIndex = rowIndex * size + columnIndex;
        let sourceX = columnIndex;
        let sourceY = rowIndex;
        if (displacement) {
          sourceX += displacement.shiftX[pixelIndex]!;
          sourceY += displacement.shiftY[pixelIndex]!;
          if (sourceX < 0) sourceX = 0;
          else if (sourceX > lastIndex) sourceX = lastIndex;
          if (sourceY < 0) sourceY = 0;
          else if (sourceY > lastIndex) sourceY = lastIndex;
        }
        let leftColumn = sourceX | 0;
        if (leftColumn > lastTopLeft) leftColumn = lastTopLeft;
        let topRow = sourceY | 0;
        if (topRow > lastTopLeft) topRow = lastTopLeft;
        const horizontalWeight = sourceX - leftColumn;
        const verticalWeight = sourceY - topRow;
        const topLeftOffset = topRow * rowStride + leftColumn * 3;
        const bottomLeftOffset = topLeftOffset + rowStride;
        const outputOffset = pixelIndex * 3;
        const isAccepted = Math.abs(storedLuminance[pixelIndex]! - robustMean[pixelIndex]!) <= acceptanceThreshold[pixelIndex]!;
        if (isAccepted) acceptedCounts[pixelIndex] = acceptedCounts[pixelIndex]! + 1;
        else rejectedSampleCount++;
        for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
          const topLeftValue = framePixels[topLeftOffset + channelIndex]!;
          const bottomLeftValue = framePixels[bottomLeftOffset + channelIndex]!;
          const topValue = topLeftValue + horizontalWeight * (framePixels[topLeftOffset + 3 + channelIndex]! - topLeftValue);
          const bottomValue = bottomLeftValue + horizontalWeight * (framePixels[bottomLeftOffset + 3 + channelIndex]! - bottomLeftValue);
          const channelGain = channelIndex === 0 ? redGain : channelIndex === 1 ? greenGain : blueGain;
          const sampleValue = channelGain * (topValue + verticalWeight * (bottomValue - topValue));
          plainSums[outputOffset + channelIndex] = plainSums[outputOffset + channelIndex]! + sampleValue;
          if (isAccepted) acceptedSums[outputOffset + channelIndex] = acceptedSums[outputOffset + channelIndex]! + sampleValue;
        }
      }
    }
  }
  const stackedChannels = new Float32Array(pixelCount * 3);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const acceptedCount = acceptedCounts[pixelIndex]!;
    for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
      const valueOffset = pixelIndex * 3 + channelIndex;
      stackedChannels[valueOffset] = acceptedCount > 0 ? acceptedSums[valueOffset]! / acceptedCount : plainSums[valueOffset]! / frameCount;
    }
  }
  const stackedImage: FloatRgbImage = { size, channels: stackedChannels };
  const mergeMilliseconds = now() - mergeStartTime;

  const referenceFloatImage = rgbToFloatImage(frames[referenceFrameIndex]!, size);
  const referenceNoise = estimateFlatAreaNoiseSigma(luminanceOfFloatImage(referenceFloatImage), size);
  const stackedNoise = estimateFlatAreaNoiseSigma(luminanceOfFloatImage(stackedImage), size);
  return {
    stackedImage,
    referenceImage: referenceFloatImage,
    referenceFrameIndex,
    usedFrameCount: frameCount,
    rejectedFraction: rejectedSampleCount / (frameCount * pixelCount),
    locallyAlignedFrameCount,
    meanShiftPixels: frameCount > 1 ? shiftSum / (frameCount - 1) : 0,
    noiseReductionFactor: stackedNoise > 0 ? referenceNoise / stackedNoise : 1,
    timings: {
      globalAlignmentMilliseconds,
      localAlignmentMilliseconds,
      mergeMilliseconds,
      totalMilliseconds: now() - startTime,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reducción de ruido
// ---------------------------------------------------------------------------------------------

/**
 * Reducción de ruido suave (`strength` 0-1): el detalle más fino de la luminancia (lo que queda
 * al restar un suavizado de σ ≈ 1 px) se encoge donde es del tamaño del ruido medido
 * (d² / (d² + τ²), que deja casi intactos los bordes marcados), y el color se suaviza.
 */
export function denoiseNightImage(image: FloatRgbImage, strength: number): FloatRgbImage {
  if (strength <= 0) return image;
  const { size, channels } = image;
  const pixelCount = size * size;
  const luminance = luminanceOfFloatImage(image);
  const blueDifference = new Float32Array(pixelCount);
  const redDifference = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    blueDifference[pixelIndex] = channels[pixelIndex * 3 + 2]! - luminance[pixelIndex]!;
    redDifference[pixelIndex] = channels[pixelIndex * 3]! - luminance[pixelIndex]!;
  }
  const noiseSigma = estimateFlatAreaNoiseSigma(luminance, size);
  const shrinkThreshold = 1.5 * strength * noiseSigma;
  const shrinkThresholdSquared = shrinkThreshold * shrinkThreshold;
  const smoothLuminance = smoothWithBinomial3(smoothWithBinomial3(luminance, size, size), size, size);
  const chromaSigma = 1 + 2 * strength;
  const smoothBlueDifference = approximateGaussianBlurPlane(blueDifference, size, size, chromaSigma);
  const smoothRedDifference = approximateGaussianBlurPlane(redDifference, size, size, chromaSigma);
  const outputChannels = new Float32Array(pixelCount * 3);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const detail = luminance[pixelIndex]! - smoothLuminance[pixelIndex]!;
    const detailSquared = detail * detail;
    const keptDetail = shrinkThresholdSquared > 0 ? (detail * detailSquared) / (detailSquared + shrinkThresholdSquared) : detail;
    const denoisedLuminance = smoothLuminance[pixelIndex]! + keptDetail;
    const red = denoisedLuminance + smoothRedDifference[pixelIndex]!;
    const blue = denoisedLuminance + smoothBlueDifference[pixelIndex]!;
    outputChannels[pixelIndex * 3] = red;
    outputChannels[pixelIndex * 3 + 1] = (denoisedLuminance - 0.299 * red - 0.114 * blue) / 0.587;
    outputChannels[pixelIndex * 3 + 2] = blue;
  }
  return { size, channels: outputChannels };
}

// ---------------------------------------------------------------------------------------------
// Revelado
// ---------------------------------------------------------------------------------------------

/** Gamma aproximada de las fotos del móvil (sRGB ≈ 2,2). */
const displayGamma = 2.2;
/** Mediana de la luminancia lineal con «Ambiente» 0 (noche) y 1 (día). */
const nightMedianTarget = 0.02;
const dayMedianTarget = 0.18;
const minimumToneGain = 0.25;
const maximumToneGain = 64;
const linearLookupSize = 1024;
const encodeLookupSize = 4096;

/** De 0-255 (con gamma) a luz lineal 0-1, tabulado (en Hermes `Math.pow` por píxel pesa). */
const linearFromEncoded = Float32Array.from({ length: linearLookupSize + 1 }, (_unused, lookupIndex) =>
  Math.pow(lookupIndex / linearLookupSize, displayGamma),
);
const encodedFromLinear = Float32Array.from({ length: encodeLookupSize + 1 }, (_unused, lookupIndex) =>
  255 * Math.pow(lookupIndex / encodeLookupSize, 1 / displayGamma),
);

function toLinear(encodedValue: number): number {
  const lookupPosition = (encodedValue < 0 ? 0 : encodedValue > 255 ? 255 : encodedValue) * (linearLookupSize / 255);
  const lowerIndex = lookupPosition | 0;
  if (lowerIndex >= linearLookupSize) return 1;
  return linearFromEncoded[lowerIndex]! + (lookupPosition - lowerIndex) * (linearFromEncoded[lowerIndex + 1]! - linearFromEncoded[lowerIndex]!);
}

function toEncoded(linearValue: number): number {
  const lookupPosition = (linearValue < 0 ? 0 : linearValue > 1 ? 1 : linearValue) * encodeLookupSize;
  const lowerIndex = lookupPosition | 0;
  if (lowerIndex >= encodeLookupSize) return 255;
  return encodedFromLinear[lowerIndex]! + (lookupPosition - lowerIndex) * (encodedFromLinear[lowerIndex + 1]! - encodedFromLinear[lowerIndex]!);
}

export interface NightToneStatistics {
  /** Negro (percentil 1 de la luminancia lineal). */
  blackLinear: number;
  medianLinear: number;
  /** Luz más fuerte que se respeta (el máximo). */
  highlightLinear: number;
}

/** Estadísticas del revelado; se miden en el apilado y se usan igual para la foto suelta. */
export function measureNightToneStatistics(image: FloatRgbImage): NightToneStatistics {
  const encodedLuminance = luminanceOfFloatImage(image);
  const linearLuminance = new Float32Array(encodedLuminance.length);
  for (let pixelIndex = 0; pixelIndex < linearLuminance.length; pixelIndex++) linearLuminance[pixelIndex] = toLinear(encodedLuminance[pixelIndex]!);
  // Las luces (farolas, ventanas) ocupan muy pocos píxeles: un percentil no las vería. Tras
  // promediar la ráfaga no quedan píxeles sueltos de ruido que lo falseen.
  let highlightLinear = 0;
  for (let pixelIndex = 0; pixelIndex < linearLuminance.length; pixelIndex++) {
    if (linearLuminance[pixelIndex]! > highlightLinear) highlightLinear = linearLuminance[pixelIndex]!;
  }
  return {
    blackLinear: percentileOfValues(linearLuminance, 1),
    medianLinear: percentileOfValues(linearLuminance, 50),
    highlightLinear,
  };
}

/** Ganancia de luz del revelado para un «Ambiente» (0-1). */
export function nightToneGain(statistics: NightToneStatistics, ambience: number): number {
  const clampedAmbience = Math.min(1, Math.max(0, ambience));
  const targetMedian = Math.exp(Math.log(nightMedianTarget) + clampedAmbience * (Math.log(dayMedianTarget) - Math.log(nightMedianTarget)));
  const blackPoint = 0.9 * statistics.blackLinear;
  const medianAboveBlack = Math.max(1e-5, statistics.medianLinear - blackPoint);
  return Math.min(maximumToneGain, Math.max(minimumToneGain, targetMedian / medianAboveBlack));
}

/**
 * Revelado en luz lineal: resta el negro, multiplica por la ganancia del «Ambiente» y comprime
 * con Reinhard extendido, L·(1 + L/W²)/(1 + L), con W = la luz más fuerte ya multiplicada: esa
 * luz acaba justo en el blanco y lo oscuro apenas se toca (con W ≤ 1 la curva es la identidad).
 * El color se conserva escalando los tres canales por igual (y, si uno se saldría, se desatura lo
 * justo). Con poco «Ambiente» el color se apaga un poco, como lo ve el ojo de noche.
 */
export function toneMapNightImage(image: FloatRgbImage, statistics: NightToneStatistics, ambience: number): FloatRgbImage {
  const { size, channels } = image;
  const pixelCount = size * size;
  const clampedAmbience = Math.min(1, Math.max(0, ambience));
  const gain = nightToneGain(statistics, clampedAmbience);
  const blackPoint = 0.9 * statistics.blackLinear;
  const whitePoint = Math.max(1, gain * (statistics.highlightLinear - blackPoint));
  const inverseWhiteSquared = 1 / (whitePoint * whitePoint);
  const saturation = 0.75 + 0.25 * clampedAmbience;
  const outputChannels = new Float32Array(pixelCount * 3);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const valueOffset = pixelIndex * 3;
    const redLinear = Math.max(0, toLinear(channels[valueOffset]!) - blackPoint) * gain;
    const greenLinear = Math.max(0, toLinear(channels[valueOffset + 1]!) - blackPoint) * gain;
    const blueLinear = Math.max(0, toLinear(channels[valueOffset + 2]!) - blackPoint) * gain;
    const scaledLuminance = 0.2126 * redLinear + 0.7152 * greenLinear + 0.0722 * blueLinear;
    const mappedLuminance = (scaledLuminance * (1 + scaledLuminance * inverseWhiteSquared)) / (1 + scaledLuminance);
    const compression = scaledLuminance > 1e-9 ? mappedLuminance / scaledLuminance : 1;
    let red = mappedLuminance + saturation * (redLinear * compression - mappedLuminance);
    let green = mappedLuminance + saturation * (greenLinear * compression - mappedLuminance);
    let blue = mappedLuminance + saturation * (blueLinear * compression - mappedLuminance);
    const largestChannel = Math.max(red, green, blue);
    if (largestChannel > 1 && mappedLuminance < 1) {
      const desaturation = (1 - mappedLuminance) / (largestChannel - mappedLuminance);
      red = mappedLuminance + desaturation * (red - mappedLuminance);
      green = mappedLuminance + desaturation * (green - mappedLuminance);
      blue = mappedLuminance + desaturation * (blue - mappedLuminance);
    }
    outputChannels[valueOffset] = toEncoded(red);
    outputChannels[valueOffset + 1] = toEncoded(green);
    outputChannels[valueOffset + 2] = toEncoded(blue);
  }
  return { size, channels: outputChannels };
}
