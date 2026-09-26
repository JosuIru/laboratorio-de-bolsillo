/**
 * Perfiles radiales a través del limbo iluminado de la Luna y función de dispersión del borde.
 *
 * El limbo es el único borde nítido y de forma conocida que hay en una foto de la Luna: la
 * superficie termina de golpe contra el cielo negro. Cómo se emborrona ese escalón es,
 * directamente, la función de dispersión de la óptica + atmósfera + enfoque. Este módulo lo
 * aprovecha (lo usan el enfoque en horquilla, la deconvolución y la corrección cromática):
 *
 *  1. Con el círculo del ajuste de disco (`fitLunarDisk`), se muestrean `angleCount` perfiles
 *     radiales de `r − L` a `r + L` (interpolación bilineal).
 *  2. Se queda con los que cruzan el limbo ILUMINADO: contraste dentro−fuera alto. Donde el
 *     círculo pasa por la parte en sombra (fases distintas de la llena) el contraste es casi nulo
 *     y el perfil se descarta; el terminador no está sobre el círculo, así que no molesta.
 *  3. Cada perfil se normaliza (1 dentro, 0 fuera) para que el albedo local no pese, y se
 *     promedian ponderados por el contraste: la función de dispersión del borde (ESF).
 *  4. Su derivada es la función de dispersión de línea (LSF), a la que se ajusta una gaussiana.
 *
 * Convenio: desplazamiento radial `r − R` en píxeles, positivo hacia fuera del disco.
 * Módulo puro: sin React ni React Native.
 */

import { type GrayImage, sampleBilinear } from './grayImage';
import { type Circle, type DiskFitOptions, fitLunarDisk, type LunarDiskFit } from './lunarDiskFit';

export interface LimbProfileOptions {
  /** Número de direcciones radiales repartidas en la circunferencia. */
  angleCount: number;
  /** Mitad de la longitud del perfil, en píxeles (se recorta a la mitad del radio). */
  halfLengthPixels: number;
  /** Paso entre muestras del perfil, en píxeles. */
  stepPixels: number;
  /** Longitud de cada extremo del perfil con que se miden los niveles de dentro y de fuera. */
  plateauLengthPixels: number;
  /** Contraste mínimo, como fracción del contraste típico de los mejores perfiles. */
  minimumContrastFraction: number;
}

export const defaultLimbProfileOptions: LimbProfileOptions = {
  angleCount: 180,
  halfLengthPixels: 10,
  stepPixels: 0.25,
  plateauLengthPixels: 2,
  minimumContrastFraction: 0.5,
};

/**
 * Ajustes del disco cada vez más tolerantes al desenfoque: con los de por defecto (perfil de
 * ±3 px) un borde de σ ≳ 2 px no se afina y el ajuste falla, justo en las fotos desenfocadas que
 * el enfoque en horquilla y la deconvolución tienen que medir.
 */
const blurTolerantDiskFitAttempts: readonly Partial<DiskFitOptions>[] = [
  {},
  { profileHalfLengthPixels: 8, smoothingSigmaPixels: 1.5, inlierTolerancePixels: 1.5 },
  { profileHalfLengthPixels: 14, smoothingSigmaPixels: 2.5, inlierTolerancePixels: 2.5 },
];

/** `fitLunarDisk` que reintenta con perfiles más largos si el borde está muy emborronado. */
export function fitLunarDiskTolerantOfBlur(image: GrayImage, partialOptions: Partial<DiskFitOptions> = {}): LunarDiskFit | null {
  for (const attemptOptions of blurTolerantDiskFitAttempts) {
    const diskFit = fitLunarDisk(image, { ...attemptOptions, ...partialOptions });
    if (diskFit) return diskFit;
  }
  return null;
}

export interface EdgeSpreadFunction {
  /** Desplazamiento radial de cada muestra, `r − R`, en píxeles (positivo hacia fuera). */
  offsetsPixels: Float32Array;
  /** Brillo normalizado: ≈ 1 dentro del disco, ≈ 0 en el cielo. */
  normalizedValues: Float32Array;
  /** Perfiles del limbo iluminado promediados. */
  profileCount: number;
  /** Contraste medio (dentro − fuera) de esos perfiles, en unidades de la imagen. */
  meanContrast: number;
  /** Ángulos (radianes, 0 = +x, hacia +y) de los perfiles usados. */
  usedAnglesRadians: number[];
}

/** Percentil sobre una copia ordenada (para listas cortas). */
function percentileOfList(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sortedValues = [...values].sort((first, second) => first - second);
  const position = Math.min(sortedValues.length - 1, Math.max(0, Math.round((percentile / 100) * (sortedValues.length - 1))));
  return sortedValues[position]!;
}

/**
 * ESF promediada del limbo iluminado, o `null` si no hay perfiles suficientes (menos de 8).
 */
export function measureLimbEdgeSpread(
  image: GrayImage,
  diskCircle: Circle,
  partialOptions: Partial<LimbProfileOptions> = {},
): EdgeSpreadFunction | null {
  const options = { ...defaultLimbProfileOptions, ...partialOptions };
  const halfLength = Math.max(2, Math.min(options.halfLengthPixels, diskCircle.radius / 2));
  const halfSampleCount = Math.round(halfLength / options.stepPixels);
  const sampleCount = 2 * halfSampleCount + 1;
  const plateauSampleCount = Math.max(1, Math.round(options.plateauLengthPixels / options.stepPixels));
  const offsetsPixels = new Float32Array(sampleCount);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    offsetsPixels[sampleIndex] = (sampleIndex - halfSampleCount) * options.stepPixels;
  }

  const profiles: { angle: number; samples: Float32Array; insideLevel: number; outsideLevel: number }[] = [];
  for (let angleIndex = 0; angleIndex < options.angleCount; angleIndex++) {
    const angle = (2 * Math.PI * angleIndex) / options.angleCount;
    const directionX = Math.cos(angle);
    const directionY = Math.sin(angle);
    const samples = new Float32Array(sampleCount);
    let isInsideImage = true;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const radialDistance = diskCircle.radius + offsetsPixels[sampleIndex]!;
      const positionX = diskCircle.centerX + radialDistance * directionX;
      const positionY = diskCircle.centerY + radialDistance * directionY;
      if (positionX < 0 || positionY < 0 || positionX > image.width - 1 || positionY > image.height - 1) {
        isInsideImage = false;
        break;
      }
      samples[sampleIndex] = sampleBilinear(image, positionX, positionY);
    }
    if (!isInsideImage) continue;
    let insideSum = 0;
    let outsideSum = 0;
    for (let plateauIndex = 0; plateauIndex < plateauSampleCount; plateauIndex++) {
      insideSum += samples[plateauIndex]!;
      outsideSum += samples[sampleCount - 1 - plateauIndex]!;
    }
    profiles.push({ angle, samples, insideLevel: insideSum / plateauSampleCount, outsideLevel: outsideSum / plateauSampleCount });
  }
  if (profiles.length === 0) return null;

  // Contraste típico de los perfiles del limbo iluminado: percentil 90 (en cuarto, la mitad de
  // los perfiles cruzan la parte en sombra y tienen contraste casi nulo).
  const contrasts = profiles.map((profile) => profile.insideLevel - profile.outsideLevel);
  const typicalContrast = percentileOfList(contrasts, 90);
  if (typicalContrast <= 0) return null;
  const minimumContrast = options.minimumContrastFraction * typicalContrast;

  const weightedSums = new Float64Array(sampleCount);
  let weightSum = 0;
  let contrastSum = 0;
  const usedAnglesRadians: number[] = [];
  for (const profile of profiles) {
    const contrast = profile.insideLevel - profile.outsideLevel;
    if (contrast < minimumContrast) continue;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const normalizedValue = (profile.samples[sampleIndex]! - profile.outsideLevel) / contrast;
      weightedSums[sampleIndex] = weightedSums[sampleIndex]! + contrast * normalizedValue;
    }
    weightSum += contrast;
    contrastSum += contrast;
    usedAnglesRadians.push(profile.angle);
  }
  if (usedAnglesRadians.length < 8) return null;
  const normalizedValues = new Float32Array(sampleCount);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    normalizedValues[sampleIndex] = weightedSums[sampleIndex]! / weightSum;
  }
  return {
    offsetsPixels,
    normalizedValues,
    profileCount: usedAnglesRadians.length,
    meanContrast: contrastSum / usedAnglesRadians.length,
    usedAnglesRadians,
  };
}

/** LSF = −d(ESF)/d(desplazamiento), por diferencias centradas entre muestras vecinas. */
export function lineSpreadFromEdgeSpread(edgeSpread: EdgeSpreadFunction): { offsetsPixels: Float32Array; values: Float32Array } {
  const { offsetsPixels, normalizedValues } = edgeSpread;
  const sampleCount = offsetsPixels.length;
  const values = new Float32Array(sampleCount);
  for (let sampleIndex = 1; sampleIndex < sampleCount - 1; sampleIndex++) {
    const offsetSpan = offsetsPixels[sampleIndex + 1]! - offsetsPixels[sampleIndex - 1]!;
    values[sampleIndex] = -(normalizedValues[sampleIndex + 1]! - normalizedValues[sampleIndex - 1]!) / offsetSpan;
  }
  return { offsetsPixels, values };
}

export interface GaussianProfileFit {
  amplitude: number;
  centerOffsetPixels: number;
  sigmaPixels: number;
  /** Error cuadrático medio del ajuste. */
  rmsResidual: number;
}

/**
 * Ajuste de `A·exp(−(x−μ)²/2σ²)` a un perfil por búsqueda en rejilla de μ y σ que se va
 * estrechando (la amplitud se resuelve por mínimos cuadrados lineales en cada punto). Más
 * robusto que Gauss-Newton con perfiles ruidosos y sin necesidad de un buen punto de partida.
 */
export function fitGaussianProfile(
  offsets: Float32Array,
  values: Float32Array,
  minimumSigmaPixels = 0.15,
  maximumSigmaPixels = 12,
): GaussianProfileFit {
  const gridSide = 25;
  const refinementLevels = 4;
  const evaluate = (centerOffset: number, sigma: number) => {
    let modelDotData = 0;
    let modelDotModel = 0;
    for (let sampleIndex = 0; sampleIndex < offsets.length; sampleIndex++) {
      const normalizedDistance = (offsets[sampleIndex]! - centerOffset) / sigma;
      const modelValue = Math.exp(-0.5 * normalizedDistance * normalizedDistance);
      modelDotData += modelValue * values[sampleIndex]!;
      modelDotModel += modelValue * modelValue;
    }
    const amplitude = modelDotModel > 0 ? modelDotData / modelDotModel : 0;
    let squaredResidualSum = 0;
    for (let sampleIndex = 0; sampleIndex < offsets.length; sampleIndex++) {
      const normalizedDistance = (offsets[sampleIndex]! - centerOffset) / sigma;
      const residual = values[sampleIndex]! - amplitude * Math.exp(-0.5 * normalizedDistance * normalizedDistance);
      squaredResidualSum += residual * residual;
    }
    return { amplitude, squaredResidualSum };
  };
  const offsetSpan = offsets[offsets.length - 1]! - offsets[0]!;
  let centerLow = offsets[0]! + offsetSpan / 4;
  let centerHigh = offsets[offsets.length - 1]! - offsetSpan / 4;
  let logSigmaLow = Math.log(minimumSigmaPixels);
  let logSigmaHigh = Math.log(maximumSigmaPixels);
  let bestFit = { amplitude: 0, centerOffsetPixels: 0, sigmaPixels: 1, squaredResidualSum: Number.POSITIVE_INFINITY };
  for (let levelIndex = 0; levelIndex < refinementLevels; levelIndex++) {
    for (let centerIndex = 0; centerIndex < gridSide; centerIndex++) {
      const centerOffset = centerLow + ((centerHigh - centerLow) * centerIndex) / (gridSide - 1);
      for (let sigmaIndex = 0; sigmaIndex < gridSide; sigmaIndex++) {
        const sigma = Math.exp(logSigmaLow + ((logSigmaHigh - logSigmaLow) * sigmaIndex) / (gridSide - 1));
        const { amplitude, squaredResidualSum } = evaluate(centerOffset, sigma);
        if (squaredResidualSum < bestFit.squaredResidualSum) {
          bestFit = { amplitude, centerOffsetPixels: centerOffset, sigmaPixels: sigma, squaredResidualSum };
        }
      }
    }
    // La rejilla siguiente cubre ±2 celdas alrededor del mejor punto.
    const centerCell = (centerHigh - centerLow) / (gridSide - 1);
    const logSigmaCell = (logSigmaHigh - logSigmaLow) / (gridSide - 1);
    centerLow = bestFit.centerOffsetPixels - 2 * centerCell;
    centerHigh = bestFit.centerOffsetPixels + 2 * centerCell;
    const bestLogSigma = Math.log(bestFit.sigmaPixels);
    logSigmaLow = Math.max(Math.log(minimumSigmaPixels), bestLogSigma - 2 * logSigmaCell);
    logSigmaHigh = Math.min(Math.log(maximumSigmaPixels), bestLogSigma + 2 * logSigmaCell);
  }
  return {
    amplitude: bestFit.amplitude,
    centerOffsetPixels: bestFit.centerOffsetPixels,
    sigmaPixels: bestFit.sigmaPixels,
    rmsResidual: Math.sqrt(bestFit.squaredResidualSum / offsets.length),
  };
}

/**
 * Varianza (px²) que el propio muestreo añade a la LSF medida y que no es de la óptica:
 *  - el píxel integra la luz en un cuadrado de 1 px: 1/12 en cualquier dirección;
 *  - la interpolación bilineal de perfiles con fases subpíxel al azar equivale a convolucionar
 *    con un triángulo de 1 px de semibase: 1/6;
 *  - la derivada por diferencias centradas es una caja de anchura 2·paso: (2·paso)²/12.
 * La PSF que hay que deshacer en la rejilla de píxeles es la medida menos todo eso.
 */
export function samplingVariancePixelsSquared(stepPixels: number): number {
  return 1 / 12 + 1 / 6 + (2 * stepPixels) ** 2 / 12;
}
