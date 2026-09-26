/**
 * Deconvolución de la Luna con la PSF medida en su propio limbo.
 *
 * En las fotos RAW del moto g57 el borde del disco tarda 3–4 px en pasar del cielo a la
 * superficie, bastante más que la difracción a f/1,8 (~1,2 µm ≈ 0,8 px): sobra enfoque, lente
 * o turbulencia. Esa transición ES la función de dispersión (PSF) de la foto concreta, así que
 * no hace falta suponerla:
 *
 *  1. ESF del limbo iluminado promediando perfiles radiales (`limbProfiles.ts`).
 *  2. LSF = derivada de la ESF; se le ajusta una gaussiana y se le resta en cuadratura lo que
 *     añade el muestreo (`samplingVariancePixelsSquared`). Para una PSF isótropa, la LSF de una
 *     gaussiana 2D de σ es una gaussiana 1D del mismo σ. (Una Moffat describiría mejor las alas
 *     de la turbulencia; con discos de ~30 px la diferencia no se puede medir, así que no se usa.)
 *  3. Richardson–Lucy con esa PSF: estimación ← estimación · Kᵀ⊛(observada / K⊛estimación).
 *     Contra la amplificación del ruido:
 *       - amortiguación (en el espíritu de White, 1994): donde el residuo es del orden del ruido,
 *         la corrección se atenúa con el factor min(1, (residuo / (k·σ))²);
 *       - parada por discrepancia: se para cuando el residuo cuadrático medio baja al nivel del
 *         ruido (seguir solo ajustaría el ruido);
 *       - variación total opcional (Dey et al., 2006): se divide por 1 − λ·div(∇u/|∇u|).
 *
 * Módulo puro: sin React ni React Native.
 */

import { gaussianBlurGray, type GrayImage } from './grayImage';
import { type Circle, type DiskFitOptions, estimateNoiseSigma } from './lunarDiskFit';
import {
  defaultLimbProfileOptions,
  fitLunarDiskTolerantOfBlur,
  type EdgeSpreadFunction,
  fitGaussianProfile,
  lineSpreadFromEdgeSpread,
  type LimbProfileOptions,
  measureLimbEdgeSpread,
  samplingVariancePixelsSquared,
} from './limbProfiles';

export interface LimbPointSpreadFunction {
  /** σ de la PSF gaussiana isótropa en la rejilla de píxeles (ya sin el muestreo). */
  sigmaPixels: number;
  /** σ de la LSF tal como se mide (con el muestreo). */
  measuredLineSpreadSigmaPixels: number;
  /** Anchura a media altura de la PSF, en píxeles (2,355·σ). */
  fullWidthHalfMaximumPixels: number;
  /** Anchura 10–90 % del borde que produce, en píxeles (2,563·σ). */
  edgeWidth10To90Pixels: number;
  /** Desplazamiento del centro de la LSF respecto al radio ajustado (sesgo del ajuste de disco). */
  edgeCenterOffsetPixels: number;
  /** Error cuadrático medio del ajuste gaussiano a la LSF, relativo a su máximo. */
  relativeFitResidual: number;
  edgeSpread: EdgeSpreadFunction;
  diskCircle: Circle;
}

/** Relaciones de la gaussiana: FWHM = 2√(2 ln 2)·σ y anchura 10–90 % del borde = 2·1,2816·σ. */
const fullWidthHalfMaximumPerSigma = 2 * Math.sqrt(2 * Math.log(2));
const edgeWidth10To90PerSigma = 2 * 1.2816;

/**
 * PSF gaussiana medida en el limbo, o `null` si no hay disco o limbo iluminado reconocible.
 * Si ya se tiene el ajuste de disco, pásalo para no repetirlo.
 */
export function estimateLimbPointSpreadFunction(
  image: GrayImage,
  diskCircle?: Circle | null,
  profileOptions: Partial<LimbProfileOptions> = {},
  diskFitOptions: Partial<DiskFitOptions> = {},
): LimbPointSpreadFunction | null {
  const fittedCircle = diskCircle ?? fitLunarDiskTolerantOfBlur(image, diskFitOptions);
  if (!fittedCircle) return null;
  const options = { ...defaultLimbProfileOptions, ...profileOptions };
  const edgeSpread = measureLimbEdgeSpread(image, fittedCircle, options);
  if (!edgeSpread) return null;
  const lineSpread = lineSpreadFromEdgeSpread(edgeSpread);
  const gaussianFit = fitGaussianProfile(lineSpread.offsetsPixels, lineSpread.values);
  const samplingVariance = samplingVariancePixelsSquared(options.stepPixels);
  // Si el borde es más fino que el propio muestreo, se deja un mínimo simbólico.
  const opticalVariance = Math.max(0.01, gaussianFit.sigmaPixels ** 2 - samplingVariance);
  const sigmaPixels = Math.sqrt(opticalVariance);
  return {
    sigmaPixels,
    measuredLineSpreadSigmaPixels: gaussianFit.sigmaPixels,
    fullWidthHalfMaximumPixels: fullWidthHalfMaximumPerSigma * sigmaPixels,
    edgeWidth10To90Pixels: edgeWidth10To90PerSigma * sigmaPixels,
    edgeCenterOffsetPixels: gaussianFit.centerOffsetPixels,
    relativeFitResidual: gaussianFit.amplitude > 0 ? gaussianFit.rmsResidual / gaussianFit.amplitude : 1,
    edgeSpread,
    diskCircle: fittedCircle,
  };
}

export interface RichardsonLucyOptions {
  /** Iteraciones máximas. */
  iterationCount: number;
  /** Umbral de la amortiguación en desviaciones del ruido (0 = sin amortiguar). */
  dampingNoiseSigmas: number;
  /** Peso λ de la variación total (0 = sin ella; valores útiles ~0,001–0,01). */
  totalVariationWeight: number;
  /** Parar cuando el residuo baja al nivel del ruido. */
  stopAtNoiseLevel: boolean;
  /** Ruido por píxel; si falta, se estima de la imagen. */
  noiseSigma?: number;
}

export const defaultRichardsonLucyOptions: RichardsonLucyOptions = {
  iterationCount: 40,
  dampingNoiseSigmas: 1,
  totalVariationWeight: 0,
  stopAtNoiseLevel: true,
};

export interface RichardsonLucyResult {
  image: GrayImage;
  iterationsPerformed: number;
  stoppedAtNoiseLevel: boolean;
  /** Residuo cuadrático medio final (observada − PSF⊛estimación). */
  finalResidualRms: number;
  noiseSigma: number;
}

/** Límite inferior del denominador de la variación total: evita divisiones explosivas. */
const minimumTotalVariationDenominator = 0.2;

/** div(∇u/|∇u|) con diferencias hacia delante para el gradiente y hacia atrás para la divergencia. */
function totalVariationCurvature(image: GrayImage, gradientFloor: number): Float32Array {
  const { width, height, values } = image;
  const normalizedGradientX = new Float32Array(width * height);
  const normalizedGradientY = new Float32Array(width * height);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      const pixelIndex = rowIndex * width + columnIndex;
      const gradientX = columnIndex < width - 1 ? values[pixelIndex + 1]! - values[pixelIndex]! : 0;
      const gradientY = rowIndex < height - 1 ? values[pixelIndex + width]! - values[pixelIndex]! : 0;
      const gradientMagnitude = Math.sqrt(gradientX * gradientX + gradientY * gradientY + gradientFloor * gradientFloor);
      normalizedGradientX[pixelIndex] = gradientX / gradientMagnitude;
      normalizedGradientY[pixelIndex] = gradientY / gradientMagnitude;
    }
  }
  const curvature = new Float32Array(width * height);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      const pixelIndex = rowIndex * width + columnIndex;
      const divergenceX = normalizedGradientX[pixelIndex]! - (columnIndex > 0 ? normalizedGradientX[pixelIndex - 1]! : 0);
      const divergenceY = normalizedGradientY[pixelIndex]! - (rowIndex > 0 ? normalizedGradientY[pixelIndex - width]! : 0);
      curvature[pixelIndex] = divergenceX + divergenceY;
    }
  }
  return curvature;
}

/**
 * Richardson–Lucy con PSF gaussiana isótropa de σ = `psfSigmaPixels`. La imagen puede tener
 * fondo y valores negativos (ruido de un RAW con el negro restado): se desplaza para que sea
 * positiva y se devuelve en la escala original.
 */
export function deconvolveRichardsonLucy(
  image: GrayImage,
  psfSigmaPixels: number,
  partialOptions: Partial<RichardsonLucyOptions> = {},
): RichardsonLucyResult {
  const options = { ...defaultRichardsonLucyOptions, ...partialOptions };
  const { width, height } = image;
  const pixelCount = width * height;
  const noiseSigma = options.noiseSigma ?? estimateNoiseSigma(image);

  let minimumValue = Number.POSITIVE_INFINITY;
  let maximumValue = Number.NEGATIVE_INFINITY;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    minimumValue = Math.min(minimumValue, image.values[pixelIndex]!);
    maximumValue = Math.max(maximumValue, image.values[pixelIndex]!);
  }
  // Suelo positivo: RL multiplica, y un cero sería un cero para siempre.
  const positivityFloor = Math.max(noiseSigma, 1e-3 * (maximumValue - minimumValue), 1e-6);
  const valueOffset = positivityFloor - minimumValue;
  const observedValues = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) observedValues[pixelIndex] = image.values[pixelIndex]! + valueOffset;

  let estimate: GrayImage = { width, height, values: observedValues.slice() };
  const dampingThreshold = options.dampingNoiseSigmas * noiseSigma;
  let iterationsPerformed = 0;
  let stoppedAtNoiseLevel = false;
  let finalResidualRms = Number.POSITIVE_INFINITY;
  for (let iterationIndex = 0; iterationIndex < options.iterationCount; iterationIndex++) {
    const reblurred = gaussianBlurGray(estimate, psfSigmaPixels);
    const correctionRatios = new Float32Array(pixelCount);
    let squaredResidualSum = 0;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const modelValue = Math.max(1e-9, reblurred.values[pixelIndex]!);
      const residual = observedValues[pixelIndex]! - modelValue;
      squaredResidualSum += residual * residual;
      const rawRatio = observedValues[pixelIndex]! / modelValue;
      const dampingFactor = dampingThreshold > 0 ? Math.min(1, (residual / dampingThreshold) ** 2) : 1;
      correctionRatios[pixelIndex] = 1 + (rawRatio - 1) * dampingFactor;
    }
    finalResidualRms = Math.sqrt(squaredResidualSum / pixelCount);
    if (options.stopAtNoiseLevel && noiseSigma > 0 && finalResidualRms <= noiseSigma) {
      stoppedAtNoiseLevel = true;
      break;
    }
    const correction = gaussianBlurGray({ width, height, values: correctionRatios }, psfSigmaPixels);
    const curvature =
      options.totalVariationWeight > 0 ? totalVariationCurvature(estimate, Math.max(1e-6, noiseSigma)) : null;
    const nextValues = new Float32Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      let updatedValue = estimate.values[pixelIndex]! * correction.values[pixelIndex]!;
      if (curvature) {
        updatedValue /= Math.max(
          minimumTotalVariationDenominator,
          1 - options.totalVariationWeight * curvature[pixelIndex]!,
        );
      }
      nextValues[pixelIndex] = Math.max(1e-9, updatedValue);
    }
    estimate = { width, height, values: nextValues };
    iterationsPerformed = iterationIndex + 1;
  }
  const outputValues = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) outputValues[pixelIndex] = estimate.values[pixelIndex]! - valueOffset;
  return {
    image: { width, height, values: outputValues },
    iterationsPerformed,
    stoppedAtNoiseLevel,
    finalResidualRms,
    noiseSigma,
  };
}

export interface LimbDeconvolutionResult extends RichardsonLucyResult {
  pointSpreadFunction: LimbPointSpreadFunction;
}

/** Todo en uno: mide la PSF en el limbo y deconvoluciona con ella. `null` si no hay limbo. */
export function deconvolveWithLimbPsf(
  image: GrayImage,
  richardsonLucyOptions: Partial<RichardsonLucyOptions> = {},
  diskCircle?: Circle | null,
): LimbDeconvolutionResult | null {
  const pointSpreadFunction = estimateLimbPointSpreadFunction(image, diskCircle);
  if (!pointSpreadFunction) return null;
  return {
    ...deconvolveRichardsonLucy(image, pointSpreadFunction.sigmaPixels, richardsonLucyOptions),
    pointSpreadFunction,
  };
}
