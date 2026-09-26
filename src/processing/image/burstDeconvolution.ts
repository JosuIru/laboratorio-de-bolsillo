/**
 * Nitidez por deconvolución para el superzoom: Richardson–Lucy sobre la luminancia con la PSF
 * gaussiana del móvil, como alternativa a la máscara de enfoque.
 *
 * La máscara de enfoque sube por igual todo el detalle fino (y con él el ruido y los halos); la
 * deconvolución deshace el desenfoque concreto que tiene la foto, así que devuelve contraste a
 * los detalles que la óptica ha apagado sin inventar bordes donde no los hay.
 *
 * PSF en la rejilla fina (ver `superResolutionPsfSigma`):
 *  - la óptica y el procesado del móvil: σ = 0,66 px del sensor en el moto g57 (medido en el
 *    limbo lunar, que es un escalón perfecto);
 *  - la fusión reparte cada muestra con un núcleo gaussiano de σ_k (0,25–0,55 px de entrada según
 *    el número de fotos): la imagen fusionada es la escena vista a través de las dos cosas, y
 *    las gaussianas se suman en cuadratura;
 *  - lo que queda del alineado (~0,1 px) también emborrona, y se suma igual.
 * Todo ello × 2 (la rejilla fina tiene el doble de píxeles por lado). Con 5 fotos:
 * 2·√(0,66² + 0,40² + 0,1²) ≈ 1,56 px. Subestimar la PSF solo deja la imagen algo menos nítida;
 * sobrestimarla crea anillos, así que ante la duda se redondea hacia abajo.
 *
 * Contra el ruido: amortiguación de White (donde el residuo es del orden del ruido la corrección
 * se atenúa, como en `limbDeconvolution`), un umbral suave sobre el cambio final (lo que cambia
 * menos que el ruido se descarta: en zonas lisas eso es todo) y pocas iteraciones, aceleradas con la extrapolación de Biggs y
 * Andrews (1997), que llega en ~5 iteraciones a donde el RL normal llega en ~12. Una sola pasada
 * da los tres niveles (suave, medio y fuerte son instantáneas a 2, 4 y 7 iteraciones).
 *
 * El color no se toca: se deconvoluciona la luminancia y la diferencia se suma a los tres canales.
 * Módulo puro: sin React ni React Native. Bucles escritos para Hermes (sin JIT).
 */

import type { FloatRgbImage } from './lunarStacking';

/** σ de la PSF del moto g57 (óptica + procesado), en píxeles de la foto, medido en el limbo lunar. */
export const defaultDevicePsfSigmaPixels = 0.66;
/** Lo que el alineado deja sin corregir (px de entrada), que también emborrona la fusión. */
const residualAlignmentJitterPixels = 0.1;
/**
 * Zoom hasta el que la cámara da píxeles reales (el moto g57 recorta en el sensor hasta ×2); por
 * encima, el móvil amplía la foto y el desenfoque, en píxeles de la foto, crece con el zoom.
 */
const nativeZoomLimit = 2;

/** σ de la PSF del móvil en píxeles de la foto para un zoom dado. */
export function devicePsfSigmaForZoom(zoomFactor: number, sensorPsfSigmaPixels = defaultDevicePsfSigmaPixels): number {
  return sensorPsfSigmaPixels * Math.max(1, zoomFactor / nativeZoomLimit);
}

/**
 * σ de la PSF de la imagen fusionada, en píxeles de la rejilla fina: la del móvil, el núcleo de
 * la fusión y el residuo del alineado en cuadratura, por el factor de ampliación.
 */
export function superResolutionPsfSigma(devicePsfSigmaPixels: number, mergeKernelSigmaPixels: number, scale: number): number {
  return (
    scale *
    Math.sqrt(devicePsfSigmaPixels ** 2 + mergeKernelSigmaPixels ** 2 + residualAlignmentJitterPixels ** 2)
  );
}

/**
 * σ de la PSF de una sola foto ampliada con interpolación bilineal: la del móvil más la del
 * núcleo triangular de la interpolación (varianza 1/6 px² por eje), por el factor de ampliación.
 */
export function bilinearUpscalePsfSigma(devicePsfSigmaPixels: number, scale: number): number {
  return scale * Math.sqrt(devicePsfSigmaPixels ** 2 + 1 / 6);
}

// ---------------------------------------------------------------------------------------------
// Ruido
// ---------------------------------------------------------------------------------------------

const noiseTileSize = 16;
/** Percentil de las zonas que se toma como «lisas». */
const flatTilePercentile = 0.1;

/**
 * Ruido por píxel medido en las zonas más lisas de la imagen: se resta a cada píxel la media de
 * sus cuatro vecinos (lo que queda es ruido más el detalle más fino), se mide su valor
 * cuadrático medio por bloques de 16 px y se toma el percentil 10 de los bloques. Con ruido
 * blanco de σ, la diferencia tiene σ·√(1 + 4/16). Las diferencias entre vecinos de toda la imagen
 * (como `estimateNoiseSigma`) lo sobrestiman mucho en fotos con textura por todas partes.
 */
export function estimateFlatAreaNoiseSigma(values: Float32Array, size: number): number {
  const tilesPerSide = Math.floor((size - 2) / noiseTileSize);
  if (tilesPerSide < 1) return 0;
  const tileRootMeanSquares: number[] = [];
  for (let tileRow = 0; tileRow < tilesPerSide; tileRow++) {
    for (let tileColumn = 0; tileColumn < tilesPerSide; tileColumn++) {
      let squaredSum = 0;
      for (let rowIndex = 1 + tileRow * noiseTileSize; rowIndex < 1 + (tileRow + 1) * noiseTileSize; rowIndex++) {
        for (let columnIndex = 1 + tileColumn * noiseTileSize; columnIndex < 1 + (tileColumn + 1) * noiseTileSize; columnIndex++) {
          const pixelIndex = rowIndex * size + columnIndex;
          const highPass =
            values[pixelIndex]! - (values[pixelIndex - 1]! + values[pixelIndex + 1]! + values[pixelIndex - size]! + values[pixelIndex + size]!) / 4;
          squaredSum += highPass * highPass;
        }
      }
      tileRootMeanSquares.push(Math.sqrt(squaredSum / (noiseTileSize * noiseTileSize)));
    }
  }
  tileRootMeanSquares.sort((first, second) => first - second);
  return tileRootMeanSquares[Math.floor(flatTilePercentile * (tileRootMeanSquares.length - 1))]! / Math.sqrt(1.25);
}

// ---------------------------------------------------------------------------------------------
// Desenfoque gaussiano rápido
// ---------------------------------------------------------------------------------------------

/**
 * Desenfoque gaussiano separable de un plano cuadrado, con el borde repetido. El núcleo llega a
 * 2,5σ (el resto pesa < 1,5 %, y se reparte al normalizar). En el interior se suman las parejas
 * simétricas sin comprobar bordes; solo las `radius` columnas y filas de cada lado van por el
 * camino lento.
 */
export function createGaussianPlaneBlur(size: number, sigmaPixels: number) {
  const kernelRadius = Math.max(1, Math.ceil(2.5 * sigmaPixels));
  const kernelWeights = new Float32Array(kernelRadius + 1);
  let kernelSum = 0;
  for (let kernelOffset = 0; kernelOffset <= kernelRadius; kernelOffset++) {
    const weight = Math.exp(-(kernelOffset * kernelOffset) / (2 * sigmaPixels * sigmaPixels));
    kernelWeights[kernelOffset] = weight;
    kernelSum += kernelOffset === 0 ? weight : 2 * weight;
  }
  for (let kernelOffset = 0; kernelOffset <= kernelRadius; kernelOffset++) kernelWeights[kernelOffset] = kernelWeights[kernelOffset]! / kernelSum;
  const centreWeight = kernelWeights[0]!;
  const horizontalPass = new Float32Array(size * size);
  const lastIndex = size - 1;

  function clampedIndex(position: number): number {
    return position < 0 ? 0 : position > lastIndex ? lastIndex : position;
  }

  return function blurPlane(input: Float32Array, output: Float32Array): void {
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      const rowStart = rowIndex * size;
      for (let columnIndex = 0; columnIndex < size; columnIndex++) {
        const pixelIndex = rowStart + columnIndex;
        let weightedSum = centreWeight * input[pixelIndex]!;
        if (columnIndex >= kernelRadius && columnIndex < size - kernelRadius) {
          for (let kernelOffset = 1; kernelOffset <= kernelRadius; kernelOffset++) {
            weightedSum += kernelWeights[kernelOffset]! * (input[pixelIndex - kernelOffset]! + input[pixelIndex + kernelOffset]!);
          }
        } else {
          for (let kernelOffset = 1; kernelOffset <= kernelRadius; kernelOffset++) {
            weightedSum +=
              kernelWeights[kernelOffset]! *
              (input[rowStart + clampedIndex(columnIndex - kernelOffset)]! + input[rowStart + clampedIndex(columnIndex + kernelOffset)]!);
          }
        }
        horizontalPass[pixelIndex] = weightedSum;
      }
    }
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      const isInterior = rowIndex >= kernelRadius && rowIndex < size - kernelRadius;
      for (let columnIndex = 0; columnIndex < size; columnIndex++) {
        const pixelIndex = rowIndex * size + columnIndex;
        let weightedSum = centreWeight * horizontalPass[pixelIndex]!;
        if (isInterior) {
          for (let kernelOffset = 1; kernelOffset <= kernelRadius; kernelOffset++) {
            const rowOffset = kernelOffset * size;
            weightedSum += kernelWeights[kernelOffset]! * (horizontalPass[pixelIndex - rowOffset]! + horizontalPass[pixelIndex + rowOffset]!);
          }
        } else {
          for (let kernelOffset = 1; kernelOffset <= kernelRadius; kernelOffset++) {
            weightedSum +=
              kernelWeights[kernelOffset]! *
              (horizontalPass[clampedIndex(rowIndex - kernelOffset) * size + columnIndex]! +
                horizontalPass[clampedIndex(rowIndex + kernelOffset) * size + columnIndex]!);
          }
        }
        output[pixelIndex] = weightedSum;
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Richardson–Lucy acelerado y amortiguado
// ---------------------------------------------------------------------------------------------

export interface AcceleratedRichardsonLucyOptions {
  /** Iteraciones tras las que se guarda una copia (en orden creciente); la última marca el final. */
  snapshotIterations: readonly number[];
  /** Umbral de la amortiguación en desviaciones del ruido (0 = sin amortiguar). */
  dampingNoiseSigmas: number;
  /** Ruido por píxel; si falta, se estima de la imagen. */
  noiseSigma?: number;
}

/** Suelo positivo: RL multiplica, y un cero sería un cero para siempre. */
const positivityFloor = 1;
/** Límite de la extrapolación de Biggs-Andrews (por encima se vuelve inestable). */
const maximumAccelerationFactor = 0.9;

/**
 * Richardson–Lucy con PSF gaussiana isótropa sobre un plano cuadrado de valores 0-255 (o
 * similares, no negativos). Devuelve una copia por cada iteración de `snapshotIterations`.
 */
export function deconvolvePlaneAccelerated(
  observedValues: Float32Array,
  size: number,
  psfSigmaPixels: number,
  options: AcceleratedRichardsonLucyOptions,
): Float32Array[] {
  const pixelCount = size * size;
  const noiseSigma = options.noiseSigma ?? estimateFlatAreaNoiseSigma(observedValues, size);
  const dampingThreshold = options.dampingNoiseSigmas * Math.max(0.5, noiseSigma);
  const inverseDampingThresholdSquared = dampingThreshold > 0 ? 1 / (dampingThreshold * dampingThreshold) : 0;
  const blurPlane = createGaussianPlaneBlur(size, psfSigmaPixels);

  const observed = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const value = observedValues[pixelIndex]! + positivityFloor;
    observed[pixelIndex] = value > positivityFloor ? value : positivityFloor;
  }
  let currentEstimate = observed.slice();
  let previousEstimate = observed.slice();
  let previousChange: Float32Array | null = null;
  let olderChange: Float32Array | null = null;
  const predictedEstimate = new Float32Array(pixelCount);
  const reblurredAndRatios = new Float32Array(pixelCount);
  const blurredCorrections = new Float32Array(pixelCount);
  const snapshots: Float32Array[] = [];
  const finalIteration = options.snapshotIterations[options.snapshotIterations.length - 1] ?? 0;

  for (let iterationIndex = 1; iterationIndex <= finalIteration; iterationIndex++) {
    // Extrapolación de Biggs-Andrews: se avanza en la dirección del último cambio, tanto como
    // se parecen los dos últimos cambios (si van en la misma dirección, se puede ir más lejos).
    let accelerationFactor = 0;
    if (previousChange && olderChange) {
      let changeProductSum = 0;
      let olderChangeSquaredSum = 0;
      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        changeProductSum += previousChange[pixelIndex]! * olderChange[pixelIndex]!;
        olderChangeSquaredSum += olderChange[pixelIndex]! * olderChange[pixelIndex]!;
      }
      if (olderChangeSquaredSum > 0) {
        accelerationFactor = Math.min(maximumAccelerationFactor, Math.max(0, changeProductSum / olderChangeSquaredSum));
      }
    }
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const extrapolated =
        currentEstimate[pixelIndex]! + accelerationFactor * (currentEstimate[pixelIndex]! - previousEstimate[pixelIndex]!);
      predictedEstimate[pixelIndex] = extrapolated > positivityFloor * 0.01 ? extrapolated : positivityFloor * 0.01;
    }

    // Paso de RL amortiguado sobre la predicción (los cocientes se escriben sobre el reemborronado).
    blurPlane(predictedEstimate, reblurredAndRatios);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const modelValue = reblurredAndRatios[pixelIndex]! > 1e-6 ? reblurredAndRatios[pixelIndex]! : 1e-6;
      const residual = observed[pixelIndex]! - modelValue;
      const dampingFactor = residual * residual * inverseDampingThresholdSquared;
      const ratioChange = observed[pixelIndex]! / modelValue - 1;
      reblurredAndRatios[pixelIndex] = 1 + (dampingThreshold > 0 && dampingFactor < 1 ? ratioChange * dampingFactor : ratioChange);
    }
    blurPlane(reblurredAndRatios, blurredCorrections);
    // Se reutilizan los planos que ya no hacen falta (son de 9 MB cada uno a 1536²).
    const nextEstimate = previousEstimate;
    const change: Float32Array = olderChange ?? new Float32Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const updatedValue = predictedEstimate[pixelIndex]! * blurredCorrections[pixelIndex]!;
      nextEstimate[pixelIndex] = updatedValue > 1e-6 ? updatedValue : 1e-6;
      change[pixelIndex] = nextEstimate[pixelIndex]! - predictedEstimate[pixelIndex]!;
    }
    olderChange = previousChange;
    previousChange = change;
    previousEstimate = currentEstimate;
    currentEstimate = nextEstimate;

    if (options.snapshotIterations.includes(iterationIndex)) {
      const snapshot = new Float32Array(pixelCount);
      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) snapshot[pixelIndex] = currentEstimate[pixelIndex]! - positivityFloor;
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

// ---------------------------------------------------------------------------------------------
// Sobre la imagen en color
// ---------------------------------------------------------------------------------------------

export type DeconvolutionLevel = 'soft' | 'medium' | 'strong';

/** Iteraciones (aceleradas) de cada nivel: 2, 4 y 7 equivalen a unas 3, 7 y 14 de RL normal. */
export const deconvolutionLevelIterations: Record<DeconvolutionLevel, number> = { soft: 2, medium: 4, strong: 7 };

export interface DeconvolvedVersions {
  images: Record<DeconvolutionLevel, FloatRgbImage>;
  psfSigmaPixels: number;
  noiseSigma: number;
}

function luminanceOf(image: FloatRgbImage): Float32Array {
  const pixelCount = image.size * image.size;
  const luminance = new Float32Array(pixelCount);
  const { channels } = image;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const pixelOffset = pixelIndex * 3;
    luminance[pixelIndex] = 0.299 * channels[pixelOffset]! + 0.587 * channels[pixelOffset + 1]! + 0.114 * channels[pixelOffset + 2]!;
  }
  return luminance;
}

/**
 * Suma a cada canal lo que la deconvolución ha cambiado la luminancia (el color queda igual),
 * con un umbral suave: los cambios menores que `changeThreshold` (del orden del ruido) se
 * anulan y a los mayores se les resta el umbral. En las zonas lisas la deconvolución solo mueve
 * ruido, y así no lo sube; en los bordes el cambio es mucho mayor y apenas se nota.
 */
function transferLuminanceChange(
  image: FloatRgbImage,
  originalLuminance: Float32Array,
  deconvolvedLuminance: Float32Array,
  changeThreshold: number,
): FloatRgbImage {
  const pixelCount = image.size * image.size;
  const outputChannels = new Float32Array(pixelCount * 3);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const rawChange = deconvolvedLuminance[pixelIndex]! - originalLuminance[pixelIndex]!;
    const luminanceChange =
      rawChange > changeThreshold ? rawChange - changeThreshold : rawChange < -changeThreshold ? rawChange + changeThreshold : 0;
    const pixelOffset = pixelIndex * 3;
    outputChannels[pixelOffset] = image.channels[pixelOffset]! + luminanceChange;
    outputChannels[pixelOffset + 1] = image.channels[pixelOffset + 1]! + luminanceChange;
    outputChannels[pixelOffset + 2] = image.channels[pixelOffset + 2]! + luminanceChange;
  }
  return { size: image.size, channels: outputChannels };
}

/** Las tres versiones (suave, media, fuerte) de una imagen en color, en una sola pasada de RL. */
export function deconvolveImageLevels(
  image: FloatRgbImage,
  psfSigmaPixels: number,
  { dampingNoiseSigmas = 0.5, changeThresholdNoiseSigmas = 0.7 }: { dampingNoiseSigmas?: number; changeThresholdNoiseSigmas?: number } = {},
): DeconvolvedVersions {
  const originalLuminance = luminanceOf(image);
  const noiseSigma = estimateFlatAreaNoiseSigma(originalLuminance, image.size);
  const levels: DeconvolutionLevel[] = ['soft', 'medium', 'strong'];
  const snapshots = deconvolvePlaneAccelerated(originalLuminance, image.size, psfSigmaPixels, {
    snapshotIterations: levels.map((level) => deconvolutionLevelIterations[level]),
    dampingNoiseSigmas,
    noiseSigma,
  });
  const images = {} as Record<DeconvolutionLevel, FloatRgbImage>;
  levels.forEach((level, levelIndex) => {
    images[level] = transferLuminanceChange(image, originalLuminance, snapshots[levelIndex]!, changeThresholdNoiseSigmas * noiseSigma);
  });
  return { images, psfSigmaPixels, noiseSigma };
}
