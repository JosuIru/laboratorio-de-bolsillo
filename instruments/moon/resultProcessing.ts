/**
 * Procesado del resultado apilado (lógica pura, sin React ni React Native):
 *  - «Corregir color»: aberración cromática lateral (R y B escalados y desplazados sobre G con el
 *    propio disco) y balance de blancos neutro sobre el disco, para los móviles que no dejan
 *    fijar el balance de blancos a luz de día.
 *  - «Nitidez (deconvolución)»: Richardson–Lucy con la PSF medida en el limbo, sobre la
 *    luminancia (una sola deconvolución); la diferencia se suma a los tres canales, así el color
 *    no cambia. El anillo del limbo se quita (`deconvolveWithLimbPsf`).
 *  - «Luna mineral»: vista alternativa con la saturación multiplicada (`renderMineralMoon`).
 *
 * El apilado viene de JPEG (0-255 con la curva sRGB): todo se hace en brillo LINEAL y se
 * vuelve a la curva sRGB para mostrarlo.
 */
import { correctLateralChromaticAberration } from '@/processing/image/chromaticAlignment';
import { createGrayImage, type GrayImage, percentileOfValues } from '@/processing/image/grayImage';
import { deconvolveWithLimbPsf } from '@/processing/image/limbDeconvolution';
import { fitLunarDiskTolerantOfBlur } from '@/processing/image/limbProfiles';
import type { Circle } from '@/processing/image/lunarDiskFit';
import type { FloatRgbImage } from '@/processing/image/lunarStacking';
import { luminanceOfPlanes, measureDiskWhiteBalance, renderMineralMoon } from '@/processing/image/mineralMoon';
import type { RgbPlanes } from '@/processing/image/rgbPlanes';

export type DeconvolutionStrength = 'off' | 'soft' | 'medium' | 'strong';
export const deconvolutionStrengths: readonly DeconvolutionStrength[] = ['off', 'soft', 'medium', 'strong'];

/** Iteraciones máximas de Richardson–Lucy por fuerza (se para antes si llega al ruido). */
const iterationsByStrength: Record<Exclude<DeconvolutionStrength, 'off'>, number> = {
  soft: 8,
  medium: 20,
  strong: 45,
};

/** A partir de este tamaño (unos 600×600 px) se limitan las iteraciones. */
const largeImagePixelCount = 600 * 600;
const largeImageMaximumIterations = 12;

export interface ResultProcessingSettings {
  correctColor: boolean;
  deconvolutionStrength: DeconvolutionStrength;
  /** Los resultados grises (imagen afortunada, luz cenicienta, RAW verde) no tienen color que corregir. */
  isColorImage: boolean;
}

export interface ResultProcessingReport {
  /** Franja de color máxima medida antes de corregir, en píxeles. */
  chromaticFringePixels?: number;
  redScale?: number;
  blueScale?: number;
  whiteBalanceGains?: { red: number; green: number; blue: number };
  psfSigmaPixels?: number;
  deconvolutionIterations?: number;
  /** Se pidió y no se pudo (no se encontró el disco o su limbo). */
  colorCorrectionFailed: boolean;
  deconvolutionFailed: boolean;
  processingMilliseconds: number;
}

export interface ProcessedMoonResult {
  image: FloatRgbImage;
  report: ResultProcessingReport;
}

/** sRGB (0-1) a lineal (0-1). */
function srgbToLinear(encodedValue: number): number {
  const clampedValue = encodedValue < 0 ? 0 : encodedValue;
  return clampedValue <= 0.04045 ? clampedValue / 12.92 : ((clampedValue + 0.055) / 1.055) ** 2.4;
}

/** Lineal (0-1) a sRGB (0-1). */
function linearToSrgb(linearValue: number): number {
  const clampedValue = linearValue < 0 ? 0 : linearValue;
  return clampedValue <= 0.0031308 ? 12.92 * clampedValue : 1.055 * clampedValue ** (1 / 2.4) - 0.055;
}

/** Imagen apilada (0-255, curva sRGB, entrelazada) a planos lineales en la misma escala 0-255. */
export function floatRgbToLinearPlanes(image: FloatRgbImage): RgbPlanes {
  const pixelCount = image.size * image.size;
  const planes: RgbPlanes = {
    width: image.size,
    height: image.size,
    red: new Float32Array(pixelCount),
    green: new Float32Array(pixelCount),
    blue: new Float32Array(pixelCount),
  };
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    planes.red[pixelIndex] = 255 * srgbToLinear(image.channels[pixelIndex * 3]! / 255);
    planes.green[pixelIndex] = 255 * srgbToLinear(image.channels[pixelIndex * 3 + 1]! / 255);
    planes.blue[pixelIndex] = 255 * srgbToLinear(image.channels[pixelIndex * 3 + 2]! / 255);
  }
  return planes;
}

/** Planos lineales (0-255) a imagen para mostrar (0-255 con la curva sRGB). */
export function linearPlanesToFloatRgb(planes: RgbPlanes): FloatRgbImage {
  const pixelCount = planes.width * planes.height;
  const channels = new Float32Array(pixelCount * 3);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    channels[pixelIndex * 3] = 255 * linearToSrgb(planes.red[pixelIndex]! / 255);
    channels[pixelIndex * 3 + 1] = 255 * linearToSrgb(planes.green[pixelIndex]! / 255);
    channels[pixelIndex * 3 + 2] = 255 * linearToSrgb(planes.blue[pixelIndex]! / 255);
  }
  return { size: planes.width, channels };
}

/** Balance de blancos: cada canal se escala alrededor de su cielo y el cielo queda gris (el del verde). */
function applyWhiteBalance(
  planes: RgbPlanes,
  gains: { red: number; blue: number },
  skyLevels: { red: number; green: number; blue: number },
): RgbPlanes {
  const pixelCount = planes.width * planes.height;
  const balancedRed = new Float32Array(pixelCount);
  const balancedBlue = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    balancedRed[pixelIndex] = skyLevels.green + (planes.red[pixelIndex]! - skyLevels.red) * gains.red;
    balancedBlue[pixelIndex] = skyLevels.green + (planes.blue[pixelIndex]! - skyLevels.blue) * gains.blue;
  }
  return { ...planes, red: balancedRed, green: planes.green.slice(), blue: balancedBlue };
}

/** Deconvoluciona la luminancia y suma la diferencia a los tres canales. */
function deconvolveLuminance(
  planes: RgbPlanes,
  diskCircle: Circle,
  strength: Exclude<DeconvolutionStrength, 'off'>,
): { planes: RgbPlanes; psfSigmaPixels: number; iterations: number } | null {
  const luminanceImage = luminanceOfPlanes(planes);
  // En recortes grandes (telescopio) cada iteración cuesta mucho en el hilo JS: se limitan.
  const iterationCount =
    planes.width * planes.height > largeImagePixelCount ? Math.min(largeImageMaximumIterations, iterationsByStrength[strength]) : iterationsByStrength[strength];
  const deconvolution = deconvolveWithLimbPsf(luminanceImage, { iterationCount }, diskCircle);
  if (!deconvolution) return null;
  const pixelCount = planes.width * planes.height;
  const sharpenedPlanes: RgbPlanes = {
    width: planes.width,
    height: planes.height,
    red: new Float32Array(pixelCount),
    green: new Float32Array(pixelCount),
    blue: new Float32Array(pixelCount),
  };
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const luminanceChange = deconvolution.image.values[pixelIndex]! - luminanceImage.values[pixelIndex]!;
    sharpenedPlanes.red[pixelIndex] = planes.red[pixelIndex]! + luminanceChange;
    sharpenedPlanes.green[pixelIndex] = planes.green[pixelIndex]! + luminanceChange;
    sharpenedPlanes.blue[pixelIndex] = planes.blue[pixelIndex]! + luminanceChange;
  }
  return {
    planes: sharpenedPlanes,
    psfSigmaPixels: deconvolution.pointSpreadFunction.sigmaPixels,
    iterations: deconvolution.iterationsPerformed,
  };
}

/** Disco del resultado (sobre el verde, en lineal). */
function fitResultDisk(planes: RgbPlanes): Circle | null {
  return fitLunarDiskTolerantOfBlur(createGrayImage(planes.width, planes.height, planes.green));
}

/** Aplica los procesados pedidos. Sin ninguno, devuelve la imagen tal cual. */
export function processMoonResult(baseImage: FloatRgbImage, settings: ResultProcessingSettings): ProcessedMoonResult {
  const startTime = Date.now();
  const shouldCorrectColor = settings.correctColor && settings.isColorImage;
  const report: ResultProcessingReport = { colorCorrectionFailed: false, deconvolutionFailed: false, processingMilliseconds: 0 };
  if (!shouldCorrectColor && settings.deconvolutionStrength === 'off') return { image: baseImage, report };
  let planes = floatRgbToLinearPlanes(baseImage);
  let diskCircle = fitResultDisk(planes);
  if (shouldCorrectColor) {
    const chromaticCorrection = diskCircle ? correctLateralChromaticAberration(planes) : null;
    if (chromaticCorrection) {
      planes = chromaticCorrection.planes;
      report.chromaticFringePixels = chromaticCorrection.measurement.maximumFringeWidthPixels;
      report.redScale = chromaticCorrection.measurement.red.scale;
      report.blueScale = chromaticCorrection.measurement.blue.scale;
      diskCircle = chromaticCorrection.measurement.greenDisk;
    }
    const diskWhiteBalance = diskCircle ? measureDiskWhiteBalance(planes, diskCircle) : null;
    if (diskWhiteBalance) {
      planes = applyWhiteBalance(planes, diskWhiteBalance.whiteBalanceGains, diskWhiteBalance.skyLevels);
      report.whiteBalanceGains = diskWhiteBalance.whiteBalanceGains;
    }
    report.colorCorrectionFailed = !chromaticCorrection && !diskWhiteBalance;
  }
  if (settings.deconvolutionStrength !== 'off') {
    const deconvolution = diskCircle ? deconvolveLuminance(planes, diskCircle, settings.deconvolutionStrength) : null;
    if (deconvolution) {
      planes = deconvolution.planes;
      report.psfSigmaPixels = deconvolution.psfSigmaPixels;
      report.deconvolutionIterations = deconvolution.iterations;
    } else {
      report.deconvolutionFailed = true;
    }
  }
  report.processingMilliseconds = Date.now() - startTime;
  return { image: linearPlanesToFloatRgb(planes), report };
}

/** Ganancias de saturación que se pueden elegir en la vista mineral. */
export const mineralSaturationGains = [3, 5, 8, 12] as const;

/**
 * Luna mineral de un resultado en color (ya procesado o no), lista para mostrar. `null` si no
 * se encuentra el disco. Primero se corrige la aberración cromática: si no, la franja del borde
 * se amplificaría como color.
 */
export function renderMineralView(baseImage: FloatRgbImage, saturationGain: number): FloatRgbImage | null {
  const linearPlanes = floatRgbToLinearPlanes(baseImage);
  const chromaticCorrection = correctLateralChromaticAberration(linearPlanes);
  const alignedPlanes = chromaticCorrection?.planes ?? linearPlanes;
  const mineralResult = renderMineralMoon(alignedPlanes, { saturationGain }, chromaticCorrection?.measurement.greenDisk ?? null);
  return mineralResult ? linearPlanesToFloatRgb(mineralResult.planes) : null;
}

/**
 * Imagen gris LINEAL (p. ej., el verde de un RAW, 0-1) como imagen para mostrar (0-255 con la
 * curva sRGB, como un JPEG), para que el realce y el procesado la traten igual que las demás.
 * Se normaliza al percentil 99,9 para que casi nada quede saturado.
 */
export function srgbImageFromLinearGray(linearImage: GrayImage): FloatRgbImage {
  if (linearImage.width !== linearImage.height) throw new Error('La imagen debe ser cuadrada');
  const whiteLevel = Math.max(1e-6, percentileOfValues(linearImage.values, 99.9));
  const channels = new Float32Array(linearImage.values.length * 3);
  for (let pixelIndex = 0; pixelIndex < linearImage.values.length; pixelIndex++) {
    const encodedValue = 255 * linearToSrgb(Math.min(1, linearImage.values[pixelIndex]! / whiteLevel));
    channels[pixelIndex * 3] = encodedValue;
    channels[pixelIndex * 3 + 1] = encodedValue;
    channels[pixelIndex * 3 + 2] = encodedValue;
  }
  return { size: linearImage.width, channels };
}
