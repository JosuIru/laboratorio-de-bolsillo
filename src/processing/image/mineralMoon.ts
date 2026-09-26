/**
 * «Luna mineral»: exagerar los colores reales, tenues, de la superficie lunar.
 *
 * La Luna parece gris, pero no lo es del todo: los mares ricos en titanio (Tranquilitatis) son
 * algo azulados y los pobres en titanio (Serenitatis, Imbrium en parte) algo anaranjados, con
 * diferencias de un pequeño porcentaje. Apilando muchas fotos (la ráfaga de 13 JPEG ya baja el
 * ruido) y multiplicando la saturación ×5–15 aparecen esas regiones.
 *
 * Pasos, en brillo lineal (si la entrada es un JPEG con gamma, pásala antes a lineal):
 *  1. Fondo: se resta el nivel del cielo de cada canal (mediana fuera del disco).
 *  2. Balance de blancos neutro: la Luna, en conjunto, se toma como gris; cada canal se escala
 *     para que su media ponderada sobre el disco iluminado sea la del verde.
 *  3. Luminancia y crominancia: Y = 0,2126 R + 0,7152 G + 0,0722 B (Rec. 709 lineal) y
 *     crominancias normalizadas cR = R/Y − 1, cB = B/Y − 1 (cero para un gris). Al dividir por
 *     Y el color no depende del sombreado ni del albedo: solo del tono.
 *  4. Ruido de color: las crominancias se suavizan con una gaussiana ponderada por Y (los píxeles
 *     oscuros, más ruidosos, pesan menos). Es el paso clave: el ruido de color aleatorio se
 *     promedia antes de amplificar, mientras que las regiones de color, extensas, sobreviven.
 *  5. Tendencia radial: se ajusta, por mínimos cuadrados ponderados por Y, un polinomio en la
 *     distancia al centro (grado 2 por defecto) a cada crominancia suavizada y se resta. En las
 *     fotos reales (moto g57, zoom 8×) la crominancia sube de forma suave y casi simétrica del
 *     centro al borde (aberración cromática lateral, el revelado del móvil, el oscurecimiento
 *     del limbo): amplificada, era un anillo naranja falso. Los mares no son anillos centrados,
 *     así que el ajuste radial apenas les quita color.
 *  6. Saturación: cR, cB se multiplican por la ganancia (5–10). En el último 10 % del radio el
 *     color se apaga poco a poco (ahí se mezclan cielo, desenfoque y lo que quede de la franja).
 *  7. Recomposición con la luminancia ORIGINAL: R = Y(1 + cR), B = Y(1 + cB) y G sale de Y.
 *     El detalle (que está en Y) no se toca: solo cambia el color.
 *
 * Fuera del disco la imagen queda gris (crominancia 0). Módulo puro: sin React ni React Native.
 */

import { createGrayImage, gaussianBlurGray, type GrayImage, percentileOfValues } from './grayImage';
import type { Circle } from './lunarDiskFit';
import { fitLunarDiskTolerantOfBlur } from './limbProfiles';
import { channelAsGrayImage, type RgbPlanes } from './rgbPlanes';

/** Coeficientes de luminancia Rec. 709 / sRGB en brillo lineal. */
const redLuminanceWeight = 0.2126;
const greenLuminanceWeight = 0.7152;
const blueLuminanceWeight = 0.0722;
/** Fracción del radio usada para el balance (el borde tiene la franja cromática y el fondo). */
const whiteBalanceRadiusFraction = 0.9;
/** Píxeles del disco más oscuros que esta fracción del percentil 95 (sombra) no cuentan en el balance. */
const minimumLitBrightnessFraction = 0.25;
/** Radio (en múltiplos del radio del disco) a partir del cual se mide el cielo. */
const skyInnerRadiusFactor = 1.15;
/** Crominancia máxima tras la ganancia, para que un píxel ruidoso no se vaya a colores imposibles. */
const maximumBoostedChroma = 0.9;

export interface MineralMoonOptions {
  /** Ganancia de saturación (5–10 lo habitual). */
  saturationGain: number;
  /** Grado del polinomio radial que se resta a la crominancia (−1 = no restar nada). */
  radialTrendDegree: number;
  /**
   * Desde esta fracción del radio hasta el borde el color se apaga poco a poco: en el limbo se
   * mezclan el cielo, la franja de la aberración cromática que queda y el desenfoque del borde.
   */
  limbColorFadeStartFraction: number;
  /** σ del suavizado de la crominancia, en píxeles (o en fracción del radio si se da la otra). */
  chromaSmoothingSigmaPixels?: number;
  /** σ del suavizado de la crominancia como fracción del radio del disco (por defecto 0,04). */
  chromaSmoothingRadiusFraction: number;
}

export const defaultMineralMoonOptions: MineralMoonOptions = {
  saturationGain: 5,
  radialTrendDegree: 2,
  limbColorFadeStartFraction: 0.9,
  chromaSmoothingRadiusFraction: 0.04,
};

export interface MineralMoonResult {
  planes: RgbPlanes;
  /** Ganancias del balance de blancos aplicadas a R, G, B. */
  whiteBalanceGains: { red: number; green: number; blue: number };
  skyLevels: { red: number; green: number; blue: number };
  diskCircle: Circle;
  chromaSmoothingSigmaPixels: number;
  /** Coeficientes (en potencias de r/R, de grado 0 en adelante) restados a cR y a cB. */
  radialTrendCoefficients: { red: number[]; blue: number[] };
}

/** Resuelve un sistema lineal pequeño por eliminación gaussiana con pivote; null si es singular. */
function solveLinearSystem(matrix: number[][], rightHandSide: number[]): number[] | null {
  const size = rightHandSide.length;
  const augmented = matrix.map((matrixRow, rowIndex) => [...matrixRow, rightHandSide[rowIndex]!]);
  for (let pivotIndex = 0; pivotIndex < size; pivotIndex++) {
    let bestRow = pivotIndex;
    for (let rowIndex = pivotIndex + 1; rowIndex < size; rowIndex++) {
      if (Math.abs(augmented[rowIndex]![pivotIndex]!) > Math.abs(augmented[bestRow]![pivotIndex]!)) bestRow = rowIndex;
    }
    if (Math.abs(augmented[bestRow]![pivotIndex]!) < 1e-12) return null;
    [augmented[pivotIndex], augmented[bestRow]] = [augmented[bestRow]!, augmented[pivotIndex]!];
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      if (rowIndex === pivotIndex) continue;
      const factor = augmented[rowIndex]![pivotIndex]! / augmented[pivotIndex]![pivotIndex]!;
      for (let columnIndex = pivotIndex; columnIndex <= size; columnIndex++) {
        augmented[rowIndex]![columnIndex] = augmented[rowIndex]![columnIndex]! - factor * augmented[pivotIndex]![columnIndex]!;
      }
    }
  }
  return augmented.map((augmentedRow, rowIndex) => augmentedRow[size]! / augmentedRow[rowIndex]!);
}

/**
 * Polinomio en ρ = r/R ajustado por mínimos cuadrados ponderados a unos valores. Devuelve los
 * coeficientes (grado 0 primero); ceros si no hay datos suficientes.
 */
export function fitRadialPolynomial(
  normalizedRadii: Float32Array,
  values: Float32Array,
  weights: Float32Array,
  degree: number,
): number[] {
  const termCount = degree + 1;
  const normalMatrix = Array.from({ length: termCount }, () => new Array<number>(termCount).fill(0));
  const normalVector = new Array<number>(termCount).fill(0);
  const powers = new Array<number>(2 * termCount).fill(0);
  for (let sampleIndex = 0; sampleIndex < values.length; sampleIndex++) {
    const weight = weights[sampleIndex]!;
    if (!(weight > 0)) continue;
    const radius = normalizedRadii[sampleIndex]!;
    powers[0] = 1;
    for (let powerIndex = 1; powerIndex < 2 * termCount - 1; powerIndex++) powers[powerIndex] = powers[powerIndex - 1]! * radius;
    for (let rowIndex = 0; rowIndex < termCount; rowIndex++) {
      normalVector[rowIndex] = normalVector[rowIndex]! + weight * powers[rowIndex]! * values[sampleIndex]!;
      for (let columnIndex = 0; columnIndex < termCount; columnIndex++) {
        normalMatrix[rowIndex]![columnIndex] = normalMatrix[rowIndex]![columnIndex]! + weight * powers[rowIndex + columnIndex]!;
      }
    }
  }
  return solveLinearSystem(normalMatrix, normalVector) ?? new Array<number>(termCount).fill(0);
}

/** 1 hasta `fadeStartFraction` del radio y baja en coseno hasta 0 en el borde. */
function limbColorFadeFactor(normalizedRadius: number, fadeStartFraction: number): number {
  if (normalizedRadius <= fadeStartFraction || fadeStartFraction >= 1) return 1;
  if (normalizedRadius >= 1) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * (normalizedRadius - fadeStartFraction)) / (1 - fadeStartFraction)));
}

function evaluatePolynomial(coefficients: readonly number[], radius: number): number {
  let value = 0;
  for (let termIndex = coefficients.length - 1; termIndex >= 0; termIndex--) value = value * radius + coefficients[termIndex]!;
  return value;
}

function medianOfList(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((first, second) => first - second);
  return values[Math.floor(values.length / 2)]!;
}

/**
 * Luna mineral a partir de una imagen RGB lineal apilada, o `null` si no se encuentra el disco.
 * `diskCircle` evita repetir el ajuste si ya se tiene.
 */
export function renderMineralMoon(
  planes: RgbPlanes,
  partialOptions: Partial<MineralMoonOptions> = {},
  diskCircle?: Circle | null,
): MineralMoonResult | null {
  const options = { ...defaultMineralMoonOptions, ...partialOptions };
  const { width, height } = planes;
  const pixelCount = width * height;
  const fittedCircle = diskCircle ?? fitLunarDiskTolerantOfBlur(channelAsGrayImage(planes, 'green'));
  if (!fittedCircle) return null;

  // 1. Nivel del cielo por canal.
  const skySamples = { red: [] as number[], green: [] as number[], blue: [] as number[] };
  const radialDistances = new Float32Array(pixelCount);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      const pixelIndex = rowIndex * width + columnIndex;
      const radialDistance = Math.hypot(columnIndex - fittedCircle.centerX, rowIndex - fittedCircle.centerY);
      radialDistances[pixelIndex] = radialDistance;
      if (radialDistance > skyInnerRadiusFactor * fittedCircle.radius) {
        skySamples.red.push(planes.red[pixelIndex]!);
        skySamples.green.push(planes.green[pixelIndex]!);
        skySamples.blue.push(planes.blue[pixelIndex]!);
      }
    }
  }
  const skyLevels = { red: medianOfList(skySamples.red), green: medianOfList(skySamples.green), blue: medianOfList(skySamples.blue) };
  const redValues = new Float32Array(pixelCount);
  const greenValues = new Float32Array(pixelCount);
  const blueValues = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    redValues[pixelIndex] = Math.max(0, planes.red[pixelIndex]! - skyLevels.red);
    greenValues[pixelIndex] = Math.max(0, planes.green[pixelIndex]! - skyLevels.green);
    blueValues[pixelIndex] = Math.max(0, planes.blue[pixelIndex]! - skyLevels.blue);
  }

  // 2. Balance de blancos sobre el disco iluminado.
  const balanceMask = new Uint8Array(pixelCount);
  const diskGreenValues: number[] = [];
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    if (radialDistances[pixelIndex]! < whiteBalanceRadiusFraction * fittedCircle.radius) diskGreenValues.push(greenValues[pixelIndex]!);
  }
  const brightGreenLevel = percentileOfValues(Float32Array.from(diskGreenValues), 95);
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    if (radialDistances[pixelIndex]! >= whiteBalanceRadiusFraction * fittedCircle.radius) continue;
    if (greenValues[pixelIndex]! < minimumLitBrightnessFraction * brightGreenLevel) continue;
    balanceMask[pixelIndex] = 1;
    redSum += redValues[pixelIndex]!;
    greenSum += greenValues[pixelIndex]!;
    blueSum += blueValues[pixelIndex]!;
  }
  if (greenSum <= 0 || redSum <= 0 || blueSum <= 0) return null;
  const whiteBalanceGains = { red: greenSum / redSum, green: 1, blue: greenSum / blueSum };

  // 3. Luminancia y crominancias normalizadas (ponderadas por Y para el suavizado).
  const luminanceValues = new Float32Array(pixelCount);
  const weightedRedChroma = new Float32Array(pixelCount);
  const weightedBlueChroma = new Float32Array(pixelCount);
  const chromaWeights = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const balancedRed = redValues[pixelIndex]! * whiteBalanceGains.red;
    const balancedGreen = greenValues[pixelIndex]!;
    const balancedBlue = blueValues[pixelIndex]! * whiteBalanceGains.blue;
    const luminance = redLuminanceWeight * balancedRed + greenLuminanceWeight * balancedGreen + blueLuminanceWeight * balancedBlue;
    luminanceValues[pixelIndex] = luminance;
    // Solo el disco aporta color: fuera, el peso es cero y la crominancia queda en 0.
    const isOnDisk = radialDistances[pixelIndex]! < fittedCircle.radius && luminance > 0;
    if (!isOnDisk) continue;
    chromaWeights[pixelIndex] = luminance;
    weightedRedChroma[pixelIndex] = balancedRed - luminance; // = Y·cR
    weightedBlueChroma[pixelIndex] = balancedBlue - luminance; // = Y·cB
  }

  // 4. Suavizado de la crominancia ponderado por Y: cR = G⊛(Y·cR) / G⊛Y.
  const chromaSmoothingSigmaPixels =
    options.chromaSmoothingSigmaPixels ?? Math.max(0.5, options.chromaSmoothingRadiusFraction * fittedCircle.radius);
  const smoothedWeights = gaussianBlurGray(createGrayImage(width, height, chromaWeights), chromaSmoothingSigmaPixels).values;
  const smoothedRedChroma = gaussianBlurGray(createGrayImage(width, height, weightedRedChroma), chromaSmoothingSigmaPixels).values;
  const smoothedBlueChroma = gaussianBlurGray(createGrayImage(width, height, weightedBlueChroma), chromaSmoothingSigmaPixels).values;

  // 5. Tendencia radial de la crominancia suavizada, ajustada solo sobre el disco.
  const normalizedRadii = new Float32Array(pixelCount);
  const smoothedRedValues = new Float32Array(pixelCount);
  const smoothedBlueValues = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    normalizedRadii[pixelIndex] = radialDistances[pixelIndex]! / fittedCircle.radius;
    const smoothedWeight = smoothedWeights[pixelIndex]!;
    if (chromaWeights[pixelIndex]! > 0 && smoothedWeight > 0) {
      smoothedRedValues[pixelIndex] = smoothedRedChroma[pixelIndex]! / smoothedWeight;
      smoothedBlueValues[pixelIndex] = smoothedBlueChroma[pixelIndex]! / smoothedWeight;
    }
  }
  const radialTrendCoefficients =
    options.radialTrendDegree >= 0
      ? {
          red: fitRadialPolynomial(normalizedRadii, smoothedRedValues, chromaWeights, options.radialTrendDegree),
          blue: fitRadialPolynomial(normalizedRadii, smoothedBlueValues, chromaWeights, options.radialTrendDegree),
        }
      : { red: [], blue: [] };

  // 6-7. Ganancia y recomposición con la luminancia original.
  const outputRed = new Float32Array(pixelCount);
  const outputGreen = new Float32Array(pixelCount);
  const outputBlue = new Float32Array(pixelCount);
  const clampChroma = (chroma: number) => Math.max(-maximumBoostedChroma, Math.min(maximumBoostedChroma, chroma));
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const luminance = luminanceValues[pixelIndex]!;
    const hasColor = chromaWeights[pixelIndex]! > 0 && smoothedWeights[pixelIndex]! > 0;
    const normalizedRadius = normalizedRadii[pixelIndex]!;
    const limbFade = limbColorFadeFactor(normalizedRadius, options.limbColorFadeStartFraction);
    const redChroma = hasColor
      ? limbFade * clampChroma(options.saturationGain * (smoothedRedValues[pixelIndex]! - evaluatePolynomial(radialTrendCoefficients.red, normalizedRadius)))
      : 0;
    const blueChroma = hasColor
      ? limbFade * clampChroma(options.saturationGain * (smoothedBlueValues[pixelIndex]! - evaluatePolynomial(radialTrendCoefficients.blue, normalizedRadius)))
      : 0;
    const recomposedRed = luminance * (1 + redChroma);
    const recomposedBlue = luminance * (1 + blueChroma);
    const recomposedGreen = (luminance - redLuminanceWeight * recomposedRed - blueLuminanceWeight * recomposedBlue) / greenLuminanceWeight;
    outputRed[pixelIndex] = Math.max(0, recomposedRed);
    outputGreen[pixelIndex] = Math.max(0, recomposedGreen);
    outputBlue[pixelIndex] = Math.max(0, recomposedBlue);
  }
  return {
    planes: { width, height, red: outputRed, green: outputGreen, blue: outputBlue },
    whiteBalanceGains,
    skyLevels,
    diskCircle: fittedCircle,
    chromaSmoothingSigmaPixels,
    radialTrendCoefficients,
  };
}

/** Luminancia Rec. 709 lineal de unos planos RGB (útil para comprobar que no cambia). */
export function luminanceOfPlanes(planes: RgbPlanes): GrayImage {
  const luminanceImage = createGrayImage(planes.width, planes.height);
  for (let pixelIndex = 0; pixelIndex < luminanceImage.values.length; pixelIndex++) {
    luminanceImage.values[pixelIndex] =
      redLuminanceWeight * planes.red[pixelIndex]! +
      greenLuminanceWeight * planes.green[pixelIndex]! +
      blueLuminanceWeight * planes.blue[pixelIndex]!;
  }
  return luminanceImage;
}
