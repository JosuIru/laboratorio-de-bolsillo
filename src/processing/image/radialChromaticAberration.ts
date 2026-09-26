/**
 * Aberración cromática lateral para el superzoom, con un modelo de escala radial.
 *
 * La lente no amplía igual los tres colores: la imagen roja (y la azul) es un poco más grande o
 * más pequeña que la verde, en proporción a la distancia al centro óptico. Cerca del centro no se
 * nota; hacia los bordes aparece un filo de color en los contornos. Se corrige remuestreando R y
 * B con una escala alrededor del centro óptico (como `resampleChannelOntoGreen`, pero sin disco
 * lunar que dé la medida):
 *     valor corregido en p = canal en (centro + escala · (p − centro)).
 *
 * El recorte del superzoom es el cuadrado central de la foto, así que el centro óptico (el centro
 * de la foto) cae cerca del centro del recorte; `opticalCenterInOutput` lo sitúa con exactitud.
 *
 * La escala puede venir de un perfil del móvil (medido una vez) o estimarse en la propia imagen:
 * en los bordes marcados, lejos del centro, se busca la escala de R (y de B) con la que su valor
 * se correlaciona mejor con el del verde.
 *
 * Módulo puro: sin React ni React Native.
 */

import type { FloatRgbImage } from './lunarStacking';

export interface RadialChromaticScales {
  /** Escala de la imagen roja respecto a la verde (radio rojo / radio verde). */
  redScale: number;
  blueScale: number;
}

/**
 * Perfil orientativo del moto g57 (cámara principal): el rojo sale un 1,7 % más pequeño que el
 * verde, medido con el disco lunar con zoom ×8 cerca del centro. El azul no se ha medido.
 */
export const motoG57ChromaticProfile: RadialChromaticScales = { redScale: 0.983, blueScale: 1 };

export interface OpticalCenter {
  centerX: number;
  centerY: number;
}

/**
 * Centro óptico (el de la foto) en píxeles de la imagen de salida: el recorte empieza en
 * (`cropLeft`, `cropTop`) de la foto y la salida lo amplía `scale` veces. Convenio: el centro del
 * píxel i está en i, así que el centro de una foto de ancho W está en (W − 1) / 2, y el píxel de
 * entrada x cae en (x + 0,5)·scale − 0,5 de la salida.
 */
export function opticalCenterInOutput(
  photoWidth: number,
  photoHeight: number,
  cropLeft: number,
  cropTop: number,
  scale: number,
): OpticalCenter {
  const centerInCropX = (photoWidth - 1) / 2 - cropLeft;
  const centerInCropY = (photoHeight - 1) / 2 - cropTop;
  return { centerX: (centerInCropX + 0.5) * scale - 0.5, centerY: (centerInCropY + 0.5) * scale - 0.5 };
}

function channelPlane(image: FloatRgbImage, channelIndex: number): Float32Array {
  const pixelCount = image.size * image.size;
  const plane = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) plane[pixelIndex] = image.channels[pixelIndex * 3 + channelIndex]!;
  return plane;
}

/** Bilineal con el borde repetido, sin llamadas a Math (para Hermes). */
function sampleClamped(plane: Float32Array, size: number, positionX: number, positionY: number): number {
  const lastIndex = size - 1;
  const clampedX = positionX < 0 ? 0 : positionX > lastIndex ? lastIndex : positionX;
  const clampedY = positionY < 0 ? 0 : positionY > lastIndex ? lastIndex : positionY;
  let leftColumn = clampedX | 0;
  if (leftColumn > size - 2) leftColumn = size - 2;
  let topRow = clampedY | 0;
  if (topRow > size - 2) topRow = size - 2;
  const horizontalWeight = clampedX - leftColumn;
  const verticalWeight = clampedY - topRow;
  const topLeftIndex = topRow * size + leftColumn;
  const topValue = plane[topLeftIndex]! + horizontalWeight * (plane[topLeftIndex + 1]! - plane[topLeftIndex]!);
  const bottomValue = plane[topLeftIndex + size]! + horizontalWeight * (plane[topLeftIndex + size + 1]! - plane[topLeftIndex + size]!);
  return topValue + verticalWeight * (bottomValue - topValue);
}

/** Corrige R y B con las escalas dadas alrededor del centro óptico. Escala 1 = ese canal no se toca. */
export function correctRadialChromaticAberration(
  image: FloatRgbImage,
  scales: RadialChromaticScales,
  opticalCenter: OpticalCenter,
): FloatRgbImage {
  const { size } = image;
  const outputChannels = image.channels.slice();
  const channelCorrections: [number, number][] = [
    [0, scales.redScale],
    [2, scales.blueScale],
  ];
  for (const [channelIndex, channelScale] of channelCorrections) {
    if (channelScale === 1) continue;
    const plane = channelPlane(image, channelIndex);
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      const sourceY = opticalCenter.centerY + channelScale * (rowIndex - opticalCenter.centerY);
      for (let columnIndex = 0; columnIndex < size; columnIndex++) {
        const sourceX = opticalCenter.centerX + channelScale * (columnIndex - opticalCenter.centerX);
        outputChannels[(rowIndex * size + columnIndex) * 3 + channelIndex] = sampleClamped(plane, size, sourceX, sourceY);
      }
    }
  }
  return { size, channels: outputChannels };
}

// ---------------------------------------------------------------------------------------------
// Estimación sobre la propia imagen
// ---------------------------------------------------------------------------------------------

export interface ChromaticScaleSearchOptions {
  minimumScale: number;
  maximumScale: number;
  scaleStep: number;
  /** Muestras de borde que se usan como mucho. */
  maximumSampleCount: number;
}

export const defaultChromaticScaleSearchOptions: ChromaticScaleSearchOptions = {
  minimumScale: 0.97,
  maximumScale: 1.03,
  // El vértice de la parábola afina bien por debajo del paso.
  scaleStep: 0.002,
  maximumSampleCount: 6000,
};

/** Fracción de los píxeles con más gradiente que se consideran bordes. */
const edgePixelFraction = 0.04;
/** Solo cuentan los bordes a más de esta fracción del radio máximo (cerca del centro no hay aberración). */
const minimumRadiusFraction = 0.3;
/** El gradiente debe apuntar al menos así de radial (coseno): solo esos bordes ven la escala. */
const minimumRadialAlignment = 0.5;
/** Mejora mínima de la correlación (1 − r) respecto a no corregir para fiarse de la estimación. */
const minimumRelativeImprovement = 0.05;

export interface ChannelScaleEstimate {
  scale: number;
  /** false si no hay bordes suficientes o la mejora es dudosa: entonces `scale` es 1. */
  isReliable: boolean;
  correlationWithoutCorrection: number;
  correlationWithCorrection: number;
}

export interface ChromaticScaleEstimate {
  red: ChannelScaleEstimate;
  blue: ChannelScaleEstimate;
  edgeSampleCount: number;
}

/** Correlación de Pearson entre dos listas de la misma longitud. */
function pearsonCorrelation(firstValues: Float32Array, secondValues: Float32Array, valueCount: number): number {
  let firstSum = 0;
  let secondSum = 0;
  for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
    firstSum += firstValues[valueIndex]!;
    secondSum += secondValues[valueIndex]!;
  }
  const firstMean = firstSum / valueCount;
  const secondMean = secondSum / valueCount;
  let productSum = 0;
  let firstSquaredSum = 0;
  let secondSquaredSum = 0;
  for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
    const firstDeviation = firstValues[valueIndex]! - firstMean;
    const secondDeviation = secondValues[valueIndex]! - secondMean;
    productSum += firstDeviation * secondDeviation;
    firstSquaredSum += firstDeviation * firstDeviation;
    secondSquaredSum += secondDeviation * secondDeviation;
  }
  const denominator = Math.sqrt(firstSquaredSum * secondSquaredSum);
  return denominator > 0 ? productSum / denominator : 0;
}

/**
 * Píxeles de borde para la estimación: los de más gradiente del verde, lejos del centro óptico y
 * con el gradiente en dirección radial (un borde tangencial no cambia al escalar).
 */
function selectRadialEdgeSamples(green: Float32Array, size: number, opticalCenter: OpticalCenter, maximumSampleCount: number): Int32Array {
  const cornerDistances = [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [size - 1, size - 1],
  ].map(([cornerX, cornerY]) => Math.hypot(cornerX! - opticalCenter.centerX, cornerY! - opticalCenter.centerY));
  const minimumRadiusSquared = (minimumRadiusFraction * Math.max(...cornerDistances)) ** 2;
  const minimumRadialAlignmentSquared = minimumRadialAlignment * minimumRadialAlignment;
  // Uno de cada dos píxeles en cada eje: sobran muestras y el recorrido cuesta la cuarta parte.
  const candidateIndices: number[] = [];
  const candidateStrengths: number[] = [];
  for (let rowIndex = 2; rowIndex < size - 2; rowIndex += 2) {
    const relativeY = rowIndex - opticalCenter.centerY;
    for (let columnIndex = 2; columnIndex < size - 2; columnIndex += 2) {
      const relativeX = columnIndex - opticalCenter.centerX;
      const radiusSquared = relativeX * relativeX + relativeY * relativeY;
      if (radiusSquared < minimumRadiusSquared) continue;
      const pixelIndex = rowIndex * size + columnIndex;
      const gradientX = green[pixelIndex + 1]! - green[pixelIndex - 1]!;
      const gradientY = green[pixelIndex + size]! - green[pixelIndex - size]!;
      const gradientSquared = gradientX * gradientX + gradientY * gradientY;
      if (gradientSquared <= 0) continue;
      // cos² del ángulo entre el gradiente y el radio, sin raíces.
      const radialProjection = gradientX * relativeX + gradientY * relativeY;
      if (radialProjection * radialProjection < minimumRadialAlignmentSquared * gradientSquared * radiusSquared) continue;
      candidateIndices.push(pixelIndex);
      candidateStrengths.push(gradientSquared);
    }
  }
  const sortedStrengths = [...candidateStrengths].sort((first, second) => second - first);
  const edgeCount = Math.max(1, Math.min(maximumSampleCount, Math.round((edgePixelFraction * size * size) / 4)));
  const strengthThreshold = sortedStrengths[Math.min(sortedStrengths.length - 1, edgeCount - 1)] ?? Number.POSITIVE_INFINITY;
  const selectedIndices: number[] = [];
  for (let candidateIndex = 0; candidateIndex < candidateIndices.length && selectedIndices.length < edgeCount; candidateIndex++) {
    if (candidateStrengths[candidateIndex]! >= strengthThreshold) selectedIndices.push(candidateIndices[candidateIndex]!);
  }
  return Int32Array.from(selectedIndices);
}

function estimateChannelScale(
  channel: Float32Array,
  green: Float32Array,
  size: number,
  sampleIndices: Int32Array,
  opticalCenter: OpticalCenter,
  options: ChromaticScaleSearchOptions,
): ChannelScaleEstimate {
  const sampleCount = sampleIndices.length;
  const greenValues = new Float32Array(sampleCount);
  const sampleX = new Float32Array(sampleCount);
  const sampleY = new Float32Array(sampleCount);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const pixelIndex = sampleIndices[sampleIndex]!;
    greenValues[sampleIndex] = green[pixelIndex]!;
    sampleX[sampleIndex] = (pixelIndex % size) - opticalCenter.centerX;
    sampleY[sampleIndex] = Math.floor(pixelIndex / size) - opticalCenter.centerY;
  }
  const channelValues = new Float32Array(sampleCount);
  const correlationAt = (candidateScale: number) => {
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      channelValues[sampleIndex] = sampleClamped(
        channel,
        size,
        opticalCenter.centerX + candidateScale * sampleX[sampleIndex]!,
        opticalCenter.centerY + candidateScale * sampleY[sampleIndex]!,
      );
    }
    return pearsonCorrelation(channelValues, greenValues, sampleCount);
  };
  const correlationWithoutCorrection = correlationAt(1);
  const unreliable: ChannelScaleEstimate = {
    scale: 1,
    isReliable: false,
    correlationWithoutCorrection,
    correlationWithCorrection: correlationWithoutCorrection,
  };
  if (sampleCount < 200) return unreliable;

  const stepCount = Math.round((options.maximumScale - options.minimumScale) / options.scaleStep);
  const candidateScales = Array.from({ length: stepCount + 1 }, (_unused, stepIndex) => options.minimumScale + stepIndex * options.scaleStep);
  const correlations = candidateScales.map(correlationAt);
  let bestIndex = 0;
  correlations.forEach((correlation, candidateIndex) => {
    if (correlation > correlations[bestIndex]!) bestIndex = candidateIndex;
  });
  // En un extremo del rango, la escala real está fuera (o no hay un máximo claro): no se corrige.
  if (bestIndex === 0 || bestIndex === candidateScales.length - 1) return unreliable;
  const previousCorrelation = correlations[bestIndex - 1]!;
  const bestCorrelation = correlations[bestIndex]!;
  const nextCorrelation = correlations[bestIndex + 1]!;
  const curvature = previousCorrelation - 2 * bestCorrelation + nextCorrelation;
  const vertexOffset = curvature < 0 ? (0.5 * (previousCorrelation - nextCorrelation)) / curvature : 0;
  const refinedScale = candidateScales[bestIndex]! + Math.max(-0.5, Math.min(0.5, vertexOffset)) * options.scaleStep;
  const correlationWithCorrection = correlationAt(refinedScale);
  // Mejora relativa de la parte no explicada (1 − r): si es mínima, la corrección no compensa el riesgo.
  const relativeImprovement =
    (correlationWithCorrection - correlationWithoutCorrection) / Math.max(1e-6, 1 - correlationWithoutCorrection);
  if (relativeImprovement < minimumRelativeImprovement) return unreliable;
  return { scale: refinedScale, isReliable: true, correlationWithoutCorrection, correlationWithCorrection };
}

/** Escalas de R y B respecto a G que mejor alinean los bordes radiales de la imagen. */
export function estimateRadialChromaticScales(
  image: FloatRgbImage,
  opticalCenter: OpticalCenter,
  options: ChromaticScaleSearchOptions = defaultChromaticScaleSearchOptions,
): ChromaticScaleEstimate {
  const { size } = image;
  const green = channelPlane(image, 1);
  const sampleIndices = selectRadialEdgeSamples(green, size, opticalCenter, options.maximumSampleCount);
  return {
    red: estimateChannelScale(channelPlane(image, 0), green, size, sampleIndices, opticalCenter, options),
    blue: estimateChannelScale(channelPlane(image, 2), green, size, sampleIndices, opticalCenter, options),
    edgeSampleCount: sampleIndices.length,
  };
}
