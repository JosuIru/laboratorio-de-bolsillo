/**
 * Luz cenicienta: la parte en sombra de una luna creciente, iluminada por la luz que refleja la
 * Tierra, es unas 1000-5000 veces más débil que la parte al sol. Ningún fotograma recoge las
 * dos: se combinan un apilado de exposición corta (la parte iluminada sin saturar) y otro de
 * exposición larga (la sombra con poco ruido, la parte iluminada quemada).
 *
 *  1. Normalizar: la larga, sin el nivel de negro, se divide por la relación de exposiciones
 *     (tiempo × ISO); ambas quedan en «unidades de la corta».
 *  2. Máscara suave por brillo: la larga vale donde no está cerca de saturar; la transición
 *     se suaviza y nunca da peso a un píxel saturado.
 *  3. Fusión: media ponderada píxel a píxel.
 *  4. Curva de tono: arcoseno hiperbólico, casi lineal en las sombras y logarítmica en las
 *     luces, para ver a la vez los mares de la luz cenicienta y los cráteres al sol.
 *
 * Los dos apilados deben estar alineados (p. ej., con el centro de `fitLunarDisk`).
 * Módulo puro: sin React ni React Native.
 */

import { gaussianBlurGray, type GrayImage, percentileOfValues } from './grayImage';

export interface EarthshineFusionOptions {
  /** Exposición larga / corta (tiempo × ganancia). Si no se conoce, `estimateExposureRatio`. */
  exposureRatio: number;
  /** Nivel de negro del sensor en los dos apilados (0 en imágenes ya procesadas). */
  blackLevel: number;
  /** Nivel a partir del cual la larga se da por saturada. */
  saturationLevel: number;
  /** Por debajo de esta fracción de la saturación, la larga pesa 1; entre ella y 0,95, baja a 0. */
  transitionStartFraction: number;
  /** Suavizado de la máscara, en píxeles, para que no se vea la costura. */
  maskBlurSigmaPixels: number;
}

export const defaultEarthshineFusionOptions: Omit<EarthshineFusionOptions, 'exposureRatio'> = {
  blackLevel: 0,
  saturationLevel: 250,
  transitionStartFraction: 0.7,
  maskBlurSigmaPixels: 2,
};

const transitionEndFraction = 0.95;

export interface EarthshineFusionResult {
  /** Brillo lineal en unidades de la exposición corta (sin el negro). */
  radiance: GrayImage;
  /** Peso de la exposición larga en cada píxel (0-1). */
  longExposureWeight: GrayImage;
}

function smoothStep(edgeStart: number, edgeEnd: number, value: number): number {
  const position = Math.min(1, Math.max(0, (value - edgeStart) / (edgeEnd - edgeStart)));
  return position * position * (3 - 2 * position);
}

/**
 * Relación entre exposiciones medida en los propios datos: mediana de larga/corta en los
 * píxeles donde la larga no satura y la corta tiene señal de sobra (el borde del terminador).
 * Útil porque el tiempo de exposición que informa el móvil no siempre es exacto.
 */
export function estimateExposureRatio(
  shortExposure: GrayImage,
  longExposure: GrayImage,
  blackLevel = 0,
  saturationLevel = 250,
): number | null {
  const shortValues = shortExposure.values;
  const longValues = longExposure.values;
  const shortSignalFloor = Math.max(4, 0.05 * (percentileOfValues(shortValues, 99.5) - blackLevel));
  const ratios: number[] = [];
  for (let pixelIndex = 0; pixelIndex < shortValues.length; pixelIndex++) {
    const shortSignal = shortValues[pixelIndex]! - blackLevel;
    const longValue = longValues[pixelIndex]!;
    if (shortSignal < shortSignalFloor || longValue > 0.8 * saturationLevel) continue;
    ratios.push((longValue - blackLevel) / shortSignal);
  }
  if (ratios.length < 20) return null;
  ratios.sort((first, second) => first - second);
  return ratios[Math.floor(ratios.length / 2)]!;
}

/** Normaliza y fusiona las dos exposiciones en una imagen lineal de alto rango dinámico. */
export function fuseEarthshineExposures(
  shortExposure: GrayImage,
  longExposure: GrayImage,
  partialOptions: Partial<EarthshineFusionOptions> & { exposureRatio: number },
): EarthshineFusionResult {
  const options = { ...defaultEarthshineFusionOptions, ...partialOptions };
  const { width, height } = shortExposure;
  if (longExposure.width !== width || longExposure.height !== height) {
    throw new Error('Las dos exposiciones deben tener el mismo tamaño');
  }
  if (options.exposureRatio <= 0) throw new Error('La relación de exposiciones debe ser positiva');
  const pixelCount = width * height;
  const transitionStart = options.transitionStartFraction * options.saturationLevel;
  const transitionEnd = transitionEndFraction * options.saturationLevel;

  const rawWeights = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    rawWeights[pixelIndex] = 1 - smoothStep(transitionStart, transitionEnd, longExposure.values[pixelIndex]!);
  }
  // Suavizar reparte el peso a los vecinos; tomar el mínimo impide que llegue a lo saturado.
  const blurredWeights = gaussianBlurGray({ width, height, values: rawWeights }, options.maskBlurSigmaPixels);
  const longWeights = new Float32Array(pixelCount);
  const radianceValues = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const longWeight = Math.min(rawWeights[pixelIndex]!, blurredWeights.values[pixelIndex]!);
    longWeights[pixelIndex] = longWeight;
    const shortRadiance = shortExposure.values[pixelIndex]! - options.blackLevel;
    const longRadiance = (longExposure.values[pixelIndex]! - options.blackLevel) / options.exposureRatio;
    radianceValues[pixelIndex] = longWeight * longRadiance + (1 - longWeight) * shortRadiance;
  }
  return {
    radiance: { width, height, values: radianceValues },
    longExposureWeight: { width, height, values: longWeights },
  };
}

export interface ToneMappingOptions {
  /** Brillo del fondo del cielo, que pasa a negro. Por defecto, el percentil 5. */
  skyLevel?: number;
  /** Brillo que pasa a blanco. Por defecto, el percentil 99,8. */
  whiteLevel?: number;
  /**
   * Brillo (sobre el cielo) donde la curva pasa de lineal a logarítmica: más bajo, más se
   * levantan las sombras. Por defecto, 1/2000 del blanco (la luz cenicienta es 1/1000-1/5000).
   */
  shadowLevel?: number;
}

/** Curva de tono asinh a 0-1: y = asinh((x − cielo)/sombras) / asinh((blanco − cielo)/sombras). */
export function toneMapHighDynamicRange(radiance: GrayImage, options: ToneMappingOptions = {}): GrayImage {
  const skyLevel = options.skyLevel ?? percentileOfValues(radiance.values, 5);
  const whiteLevel = options.whiteLevel ?? percentileOfValues(radiance.values, 99.8);
  const brightnessSpan = Math.max(1e-6, whiteLevel - skyLevel);
  const shadowLevel = Math.max(1e-6, options.shadowLevel ?? brightnessSpan / 2000);
  const normalization = 1 / Math.asinh(brightnessSpan / shadowLevel);
  const displayValues = new Float32Array(radiance.values.length);
  for (let pixelIndex = 0; pixelIndex < displayValues.length; pixelIndex++) {
    const aboveSky = Math.max(0, radiance.values[pixelIndex]! - skyLevel);
    displayValues[pixelIndex] = Math.min(1, Math.asinh(aboveSky / shadowLevel) * normalization);
  }
  return { width: radiance.width, height: radiance.height, values: displayValues };
}

/** Proceso completo: fusión y curva de tono, lista para mostrar (0-1). */
export function renderEarthshineHdr(
  shortExposure: GrayImage,
  longExposure: GrayImage,
  fusionOptions: Partial<EarthshineFusionOptions> & { exposureRatio: number },
  toneMappingOptions: ToneMappingOptions = {},
): { displayImage: GrayImage } & EarthshineFusionResult {
  const fusionResult = fuseEarthshineExposures(shortExposure, longExposure, fusionOptions);
  return { ...fusionResult, displayImage: toneMapHighDynamicRange(fusionResult.radiance, toneMappingOptions) };
}
