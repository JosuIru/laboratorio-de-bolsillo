/**
 * Cronometraje de ocultaciones lunares: el instante en que una estrella desaparece tras el limbo
 * de la Luna (o reaparece), a partir de una serie de fotogramas con marca de tiempo.
 *
 *  1. Fotometría de apertura en cada fotograma: suma del brillo en un círculo alrededor de la
 *     estrella menos el cielo (mediana de un anillo), `measureApertureFlux`.
 *  2. Ajuste de un modelo de la curva de luz, por mínimos cuadrados:
 *       flujo(t) = nivel_oculto + (nivel_visible − nivel_oculto) · F(t − t₀)
 *     con los dos niveles resueltos linealmente para cada t₀ y t₀ buscado en una rejilla fina y
 *     afinado por sección dorada. F es la fracción de luz de la estrella PROMEDIADA durante la
 *     exposición de cada fotograma (el sensor integra):
 *       - 'step': escalón ideal (una estrella puntual tapada por un borde recto). Integrado sobre
 *         la exposición es una rampa: el «escalón suavizado».
 *       - 'fresnel': difracción de Fresnel en un borde recto. La estrella no se apaga de golpe:
 *         hay franjas de ~1,4× el brillo antes de caer. Con w = x·√(2/(λ·D)), x la distancia al
 *         borde geométrico de la sombra en el suelo (x = v·|t − t₀|, v la velocidad del limbo
 *         perpendicular a sí mismo), la intensidad es I(w) = ½[(C(w) + ½)² + (S(w) + ½)²]
 *         (Born y Wolf, «Principles of Optics», §8.7), con C y S las integrales de Fresnel.
 *         A 384 000 km y 550 nm la escala de Fresnel √(λD/2) es de ~10 m: a ~0,5 km/s,
 *         unos 20 ms. Solo se distingue con fotogramas muy cortos; si no, basta 'step'.
 *  3. Incertidumbre de t₀ por la curvatura del χ² en el mínimo (Δχ² = 1), con el ruido de
 *     cada punto dado o estimado de los residuos.
 *
 * Supuestos: estrella puntual (su diámetro angular ensancha la caída), limbo localmente recto y
 * marcas de tiempo exactas (el reloj del móvil puede ir desplazado cientos de ms: sincronízalo
 * con GPS o NTP). Módulo puro: sin React ni React Native.
 */

import type { GrayImage } from './grayImage';

// ---------------------------------------------------------------------------------------------
// 1. Fotometría de apertura
// ---------------------------------------------------------------------------------------------

export interface ApertureFlux {
  /** Suma de (brillo − cielo) dentro de la apertura. */
  flux: number;
  skyLevelPerPixel: number;
  aperturePixelCount: number;
  /** Incertidumbre del flujo por el ruido del cielo (sin el ruido de fotones de la estrella). */
  fluxUncertainty: number;
}

/** Flujo de una estrella en (centerX, centerY) con apertura circular y anillo de cielo. */
export function measureApertureFlux(
  image: GrayImage,
  centerX: number,
  centerY: number,
  apertureRadiusPixels: number,
  skyInnerRadiusPixels = apertureRadiusPixels * 2,
  skyOuterRadiusPixels = apertureRadiusPixels * 3,
): ApertureFlux {
  const skyValues: number[] = [];
  let apertureSum = 0;
  let aperturePixelCount = 0;
  const firstRow = Math.max(0, Math.floor(centerY - skyOuterRadiusPixels));
  const lastRow = Math.min(image.height - 1, Math.ceil(centerY + skyOuterRadiusPixels));
  const firstColumn = Math.max(0, Math.floor(centerX - skyOuterRadiusPixels));
  const lastColumn = Math.min(image.width - 1, Math.ceil(centerX + skyOuterRadiusPixels));
  for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
    for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex++) {
      const distance = Math.hypot(columnIndex - centerX, rowIndex - centerY);
      const value = image.values[rowIndex * image.width + columnIndex]!;
      if (distance <= apertureRadiusPixels) {
        apertureSum += value;
        aperturePixelCount++;
      } else if (distance >= skyInnerRadiusPixels && distance <= skyOuterRadiusPixels) {
        skyValues.push(value);
      }
    }
  }
  skyValues.sort((first, second) => first - second);
  const skyLevelPerPixel = skyValues.length > 0 ? skyValues[Math.floor(skyValues.length / 2)]! : 0;
  // Dispersión robusta del cielo: 1,4826 × desviación absoluta mediana.
  const absoluteDeviations = skyValues.map((value) => Math.abs(value - skyLevelPerPixel)).sort((first, second) => first - second);
  const skySigma = absoluteDeviations.length > 0 ? 1.4826 * absoluteDeviations[Math.floor(absoluteDeviations.length / 2)]! : 0;
  return {
    flux: apertureSum - skyLevelPerPixel * aperturePixelCount,
    skyLevelPerPixel,
    aperturePixelCount,
    fluxUncertainty: skySigma * Math.sqrt(aperturePixelCount),
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Modelos de la curva de luz
// ---------------------------------------------------------------------------------------------

/** Longitud de onda efectiva por defecto (verde, donde el sensor es más sensible). */
const defaultWavelengthMeters = 550e-9;
/** Distancia media Tierra–Luna. */
const defaultMoonDistanceMeters = 384_400_000;
/** Semiancho, en tiempos de Fresnel, de la búsqueda con Fresnel alrededor del instante del escalón. */
const fresnelSearchHalfWidthInFresnelTimes = 5;
/** Submuestras con que se promedia el modelo durante la exposición. */
const exposureSubsampleCount = 12;

/** Integrales de Fresnel C(w), S(w) tabuladas en [−maxW, maxW] con paso fino (se calculan una vez). */
const fresnelTableHalfRange = 8;
const fresnelTableStep = 0.002;
let fresnelIntensityTable: Float64Array | null = null;

/** Intensidad de Fresnel de un borde recto, tabulada por integración trapezoidal. */
function buildFresnelIntensityTable(): Float64Array {
  const halfSampleCount = Math.round(fresnelTableHalfRange / fresnelTableStep);
  const cosineIntegral = new Float64Array(2 * halfSampleCount + 1);
  const sineIntegral = new Float64Array(2 * halfSampleCount + 1);
  // C y S son impares: se integra de 0 hacia fuera y se refleja.
  const integrationSubsteps = 4;
  const substep = fresnelTableStep / integrationSubsteps;
  let cosineSum = 0;
  let sineSum = 0;
  for (let sampleIndex = 1; sampleIndex <= halfSampleCount; sampleIndex++) {
    for (let substepIndex = 0; substepIndex < integrationSubsteps; substepIndex++) {
      const startW = (sampleIndex - 1) * fresnelTableStep + substepIndex * substep;
      const endW = startW + substep;
      cosineSum += (substep / 2) * (Math.cos((Math.PI * startW * startW) / 2) + Math.cos((Math.PI * endW * endW) / 2));
      sineSum += (substep / 2) * (Math.sin((Math.PI * startW * startW) / 2) + Math.sin((Math.PI * endW * endW) / 2));
    }
    cosineIntegral[halfSampleCount + sampleIndex] = cosineSum;
    sineIntegral[halfSampleCount + sampleIndex] = sineSum;
    cosineIntegral[halfSampleCount - sampleIndex] = -cosineSum;
    sineIntegral[halfSampleCount - sampleIndex] = -sineSum;
  }
  const intensityTable = new Float64Array(2 * halfSampleCount + 1);
  for (let sampleIndex = 0; sampleIndex < intensityTable.length; sampleIndex++) {
    intensityTable[sampleIndex] = 0.5 * ((cosineIntegral[sampleIndex]! + 0.5) ** 2 + (sineIntegral[sampleIndex]! + 0.5) ** 2);
  }
  return intensityTable;
}

/**
 * Intensidad relativa (1 = sin tapar) a la distancia de Fresnel w del borde de la sombra
 * (w > 0 fuera de la sombra). Fuera de la tabla, desarrollos asintóticos.
 */
export function fresnelEdgeIntensity(fresnelDistance: number): number {
  if (fresnelDistance >= fresnelTableHalfRange) {
    // C ≈ ½ + sen(πw²/2)/(πw), S ≈ ½ − cos(πw²/2)/(πw).
    const phase = (Math.PI * fresnelDistance * fresnelDistance) / 2;
    const amplitude = 1 / (Math.PI * fresnelDistance);
    return 0.5 * ((1 + amplitude * Math.sin(phase)) ** 2 + (1 - amplitude * Math.cos(phase)) ** 2);
  }
  if (fresnelDistance <= -fresnelTableHalfRange) return 1 / (2 * Math.PI * Math.PI * fresnelDistance * fresnelDistance);
  fresnelIntensityTable ??= buildFresnelIntensityTable();
  const tablePosition = (fresnelDistance + fresnelTableHalfRange) / fresnelTableStep;
  const lowerIndex = Math.min(fresnelIntensityTable.length - 2, Math.floor(tablePosition));
  const fraction = tablePosition - lowerIndex;
  return fresnelIntensityTable[lowerIndex]! * (1 - fraction) + fresnelIntensityTable[lowerIndex + 1]! * fraction;
}

export type OccultationEventType = 'disappearance' | 'reappearance';
export type OccultationModel = 'step' | 'fresnel';

export interface LightCurveModelParameters {
  eventType: OccultationEventType;
  model: OccultationModel;
  /** Duración de cada exposición, en segundos (0 = instantánea). */
  exposureSeconds: number;
  /** Solo para 'fresnel': velocidad del limbo perpendicular a sí mismo, m/s. */
  limbVelocityMetersPerSecond: number;
  wavelengthMeters: number;
  moonDistanceMeters: number;
}

/** Fracción visible instantánea a un tiempo `timeFromEvent` = t − t₀. */
function instantaneousVisibleFraction(timeFromEvent: number, parameters: LightCurveModelParameters): number {
  // Tiempo «hacia fuera de la sombra»: positivo cuando la estrella está visible.
  const timeOutsideShadow = parameters.eventType === 'disappearance' ? -timeFromEvent : timeFromEvent;
  if (parameters.model === 'step') return timeOutsideShadow > 0 ? 1 : timeOutsideShadow < 0 ? 0 : 0.5;
  const distanceFromShadowEdge = parameters.limbVelocityMetersPerSecond * timeOutsideShadow;
  const fresnelDistance = distanceFromShadowEdge * Math.sqrt(2 / (parameters.wavelengthMeters * parameters.moonDistanceMeters));
  return fresnelEdgeIntensity(fresnelDistance);
}

/**
 * Fracción visible promediada en la exposición centrada en `timeFromEvent`. Para el escalón se
 * integra exactamente (rampa); para Fresnel, con submuestras.
 */
export function exposureAveragedVisibleFraction(timeFromEvent: number, parameters: LightCurveModelParameters): number {
  const halfExposure = parameters.exposureSeconds / 2;
  if (halfExposure <= 0) return instantaneousVisibleFraction(timeFromEvent, parameters);
  if (parameters.model === 'step') {
    const timeOutsideShadow = parameters.eventType === 'disappearance' ? -timeFromEvent : timeFromEvent;
    return Math.min(1, Math.max(0, (timeOutsideShadow + halfExposure) / parameters.exposureSeconds));
  }
  let fractionSum = 0;
  for (let subsampleIndex = 0; subsampleIndex < exposureSubsampleCount; subsampleIndex++) {
    const subsampleTime = timeFromEvent - halfExposure + ((subsampleIndex + 0.5) * parameters.exposureSeconds) / exposureSubsampleCount;
    fractionSum += instantaneousVisibleFraction(subsampleTime, parameters);
  }
  return fractionSum / exposureSubsampleCount;
}

// ---------------------------------------------------------------------------------------------
// 3. Ajuste
// ---------------------------------------------------------------------------------------------

export interface LightCurveSample {
  /** Centro de la exposición, en segundos (cualquier origen). */
  timeSeconds: number;
  flux: number;
  /** Incertidumbre del flujo; si falta, se estima de los residuos. */
  fluxUncertainty?: number;
}

export interface OccultationFitOptions {
  model: OccultationModel;
  /** 'auto' prueba los dos sentidos y se queda con el de menor χ². */
  eventType: OccultationEventType | 'auto';
  exposureSeconds: number;
  limbVelocityMetersPerSecond: number;
  wavelengthMeters: number;
  moonDistanceMeters: number;
  /** Divisiones del intervalo entre muestras en la búsqueda inicial de t₀. */
  searchSubdivisionsPerSample: number;
}

export const defaultOccultationFitOptions: OccultationFitOptions = {
  model: 'step',
  eventType: 'auto',
  exposureSeconds: 0,
  limbVelocityMetersPerSecond: 500,
  wavelengthMeters: defaultWavelengthMeters,
  moonDistanceMeters: defaultMoonDistanceMeters,
  searchSubdivisionsPerSample: 20,
};

export interface OccultationTiming {
  eventType: OccultationEventType;
  eventTimeSeconds: number;
  /** Incertidumbre (1σ) del instante, en segundos. */
  eventTimeUncertaintySeconds: number;
  visibleLevel: number;
  hiddenLevel: number;
  /** Salto de brillo dividido por su incertidumbre: por debajo de ~5, el evento es dudoso. */
  dropSignificance: number;
  residualRms: number;
  reducedChiSquared: number;
  model: OccultationModel;
}

interface LevelFit {
  chiSquared: number;
  visibleLevel: number;
  hiddenLevel: number;
  amplitudeUncertainty: number;
}

/** Niveles por mínimos cuadrados ponderados: flujo = oculto + (visible − oculto)·F. */
function fitLevelsForEventTime(
  samples: readonly LightCurveSample[],
  sampleWeights: Float64Array,
  eventTime: number,
  modelParameters: LightCurveModelParameters,
): LevelFit {
  let weightSum = 0;
  let weightedFractionSum = 0;
  let weightedFractionSquaredSum = 0;
  let weightedFluxSum = 0;
  let weightedFractionFluxSum = 0;
  const visibleFractions = new Float64Array(samples.length);
  samples.forEach((sample, sampleIndex) => {
    const visibleFraction = exposureAveragedVisibleFraction(sample.timeSeconds - eventTime, modelParameters);
    visibleFractions[sampleIndex] = visibleFraction;
    const weight = sampleWeights[sampleIndex]!;
    weightSum += weight;
    weightedFractionSum += weight * visibleFraction;
    weightedFractionSquaredSum += weight * visibleFraction * visibleFraction;
    weightedFluxSum += weight * sample.flux;
    weightedFractionFluxSum += weight * visibleFraction * sample.flux;
  });
  const determinant = weightSum * weightedFractionSquaredSum - weightedFractionSum * weightedFractionSum;
  if (determinant <= 0) return { chiSquared: Number.POSITIVE_INFINITY, visibleLevel: 0, hiddenLevel: 0, amplitudeUncertainty: Number.POSITIVE_INFINITY };
  const amplitude = (weightSum * weightedFractionFluxSum - weightedFractionSum * weightedFluxSum) / determinant;
  const hiddenLevel = (weightedFluxSum - amplitude * weightedFractionSum) / weightSum;
  let chiSquared = 0;
  samples.forEach((sample, sampleIndex) => {
    const residual = sample.flux - (hiddenLevel + amplitude * visibleFractions[sampleIndex]!);
    chiSquared += sampleWeights[sampleIndex]! * residual * residual;
  });
  return { chiSquared, visibleLevel: hiddenLevel + amplitude, hiddenLevel, amplitudeUncertainty: Math.sqrt(weightSum / determinant) };
}

/** Mínimo por sección dorada de una función unimodal en [inicio, fin]. */
function goldenSectionMinimum(objective: (value: number) => number, intervalStart: number, intervalEnd: number, tolerance: number): number {
  const inverseGoldenRatio = (Math.sqrt(5) - 1) / 2;
  let lowerBound = intervalStart;
  let upperBound = intervalEnd;
  let innerLower = upperBound - inverseGoldenRatio * (upperBound - lowerBound);
  let innerUpper = lowerBound + inverseGoldenRatio * (upperBound - lowerBound);
  let valueAtInnerLower = objective(innerLower);
  let valueAtInnerUpper = objective(innerUpper);
  while (upperBound - lowerBound > tolerance) {
    if (valueAtInnerLower < valueAtInnerUpper) {
      upperBound = innerUpper;
      innerUpper = innerLower;
      valueAtInnerUpper = valueAtInnerLower;
      innerLower = upperBound - inverseGoldenRatio * (upperBound - lowerBound);
      valueAtInnerLower = objective(innerLower);
    } else {
      lowerBound = innerLower;
      innerLower = innerUpper;
      valueAtInnerLower = valueAtInnerUpper;
      innerUpper = lowerBound + inverseGoldenRatio * (upperBound - lowerBound);
      valueAtInnerUpper = objective(innerUpper);
    }
  }
  return (lowerBound + upperBound) / 2;
}

/** Ajuste para un sentido concreto del evento. */
function fitOccultationForEventType(
  sortedSamples: readonly LightCurveSample[],
  eventType: OccultationEventType,
  options: OccultationFitOptions,
): OccultationTiming & { chiSquared: number } {
  const modelParameters: LightCurveModelParameters = { ...options, eventType };
  const sampleCount = sortedSamples.length;
  const firstTime = sortedSamples[0]!.timeSeconds;
  const lastTime = sortedSamples[sampleCount - 1]!.timeSeconds;
  const typicalSpacing = (lastTime - firstTime) / (sampleCount - 1);
  const hasGivenUncertainties = sortedSamples.every((sample) => sample.fluxUncertainty !== undefined && sample.fluxUncertainty > 0);
  const sampleWeights = Float64Array.from(sortedSamples, (sample) => (hasGivenUncertainties ? 1 / sample.fluxUncertainty! ** 2 : 1));

  // Búsqueda en rejilla y afinado alrededor del mejor punto. Fresnel es caro (submuestras por
  // exposición): se busca solo cerca del instante que da el escalón, que es casi el mismo.
  let searchStart = firstTime;
  let searchEnd = lastTime;
  if (options.model === 'fresnel') {
    const stepTiming = fitOccultationForEventType(sortedSamples, eventType, { ...options, model: 'step' });
    const fresnelScaleMeters = Math.sqrt((options.wavelengthMeters * options.moonDistanceMeters) / 2);
    const fresnelTimeSeconds = fresnelScaleMeters / Math.max(1e-6, options.limbVelocityMetersPerSecond);
    const searchHalfWidth = 3 * typicalSpacing + fresnelSearchHalfWidthInFresnelTimes * fresnelTimeSeconds;
    searchStart = Math.max(firstTime, stepTiming.eventTimeSeconds - searchHalfWidth);
    searchEnd = Math.min(lastTime, stepTiming.eventTimeSeconds + searchHalfWidth);
  }
  const gridStep = typicalSpacing / options.searchSubdivisionsPerSample;
  let bestGridTime = searchStart;
  let bestGridChiSquared = Number.POSITIVE_INFINITY;
  for (let candidateTime = searchStart; candidateTime <= searchEnd; candidateTime += gridStep) {
    const { chiSquared } = fitLevelsForEventTime(sortedSamples, sampleWeights, candidateTime, modelParameters);
    if (chiSquared < bestGridChiSquared) {
      bestGridChiSquared = chiSquared;
      bestGridTime = candidateTime;
    }
  }
  const chiSquaredAt = (eventTime: number) => fitLevelsForEventTime(sortedSamples, sampleWeights, eventTime, modelParameters).chiSquared;
  const eventTimeSeconds = goldenSectionMinimum(chiSquaredAt, bestGridTime - gridStep, bestGridTime + gridStep, gridStep * 1e-4);
  const bestLevels = fitLevelsForEventTime(sortedSamples, sampleWeights, eventTimeSeconds, modelParameters);

  // Escala del ruido: si no se dio, se toma de los residuos (χ² reducido = 1 por construcción).
  const degreesOfFreedom = Math.max(1, sampleCount - 3);
  const noiseVarianceScale = hasGivenUncertainties ? 1 : bestLevels.chiSquared / degreesOfFreedom;
  const reducedChiSquared = hasGivenUncertainties ? bestLevels.chiSquared / degreesOfFreedom : 1;

  // Curvatura del χ² (normalizado al ruido) con diferencias centradas; paso de una fracción de la exposición.
  const curvatureStep = Math.max(1e-6, Math.min(typicalSpacing, options.exposureSeconds > 0 ? options.exposureSeconds : typicalSpacing) / 10);
  const secondDerivative =
    (chiSquaredAt(eventTimeSeconds + curvatureStep) - 2 * bestLevels.chiSquared + chiSquaredAt(eventTimeSeconds - curvatureStep)) /
    (curvatureStep * curvatureStep) /
    noiseVarianceScale;
  const curvatureUncertainty = secondDerivative > 0 ? Math.sqrt(2 / secondDerivative) : Number.POSITIVE_INFINITY;
  // Con el escalón, un evento en el tiempo muerto entre exposiciones no cambia ningún fotograma:
  // el χ² es plano ahí y t₀ solo se conoce dentro de ese hueco (distribución uniforme, anchura/√12).
  const deadTimeSeconds = options.model === 'step' ? Math.max(0, typicalSpacing - options.exposureSeconds) : 0;
  const deadTimeUncertainty = deadTimeSeconds / Math.sqrt(12);
  const eventTimeUncertaintySeconds = Number.isFinite(curvatureUncertainty)
    ? Math.hypot(curvatureUncertainty, deadTimeUncertainty)
    : deadTimeUncertainty > 0
      ? deadTimeUncertainty
      : curvatureUncertainty;

  let squaredResidualSum = 0;
  for (const sample of sortedSamples) {
    const visibleFraction = exposureAveragedVisibleFraction(sample.timeSeconds - eventTimeSeconds, modelParameters);
    squaredResidualSum += (sample.flux - (bestLevels.hiddenLevel + (bestLevels.visibleLevel - bestLevels.hiddenLevel) * visibleFraction)) ** 2;
  }
  const amplitudeUncertainty = bestLevels.amplitudeUncertainty * Math.sqrt(noiseVarianceScale);
  return {
    eventType,
    eventTimeSeconds,
    eventTimeUncertaintySeconds,
    visibleLevel: bestLevels.visibleLevel,
    hiddenLevel: bestLevels.hiddenLevel,
    dropSignificance: (bestLevels.visibleLevel - bestLevels.hiddenLevel) / amplitudeUncertainty,
    residualRms: Math.sqrt(squaredResidualSum / sampleCount),
    reducedChiSquared,
    model: options.model,
    chiSquared: bestLevels.chiSquared,
  };
}

/**
 * Instante de la desaparición o reaparición, o `null` con menos de 6 muestras. Con
 * `eventType: 'auto'` se elige el sentido de mejor ajuste en el que la estrella está visible a
 * un lado y oculta al otro (salto positivo).
 */
export function fitOccultationTiming(
  samples: readonly LightCurveSample[],
  partialOptions: Partial<OccultationFitOptions> = {},
): OccultationTiming | null {
  const options = { ...defaultOccultationFitOptions, ...partialOptions };
  if (samples.length < 6) return null;
  const sortedSamples = [...samples].sort((first, second) => first.timeSeconds - second.timeSeconds);
  const candidateTypes: OccultationEventType[] = options.eventType === 'auto' ? ['disappearance', 'reappearance'] : [options.eventType];
  let bestTiming: (OccultationTiming & { chiSquared: number }) | null = null;
  for (const eventType of candidateTypes) {
    const timing = fitOccultationForEventType(sortedSamples, eventType, options);
    // Un salto negativo sería el otro sentido del evento.
    if (options.eventType === 'auto' && timing.visibleLevel <= timing.hiddenLevel) continue;
    if (!bestTiming || timing.chiSquared < bestTiming.chiSquared) bestTiming = timing;
  }
  if (!bestTiming) return null;
  return {
    eventType: bestTiming.eventType,
    eventTimeSeconds: bestTiming.eventTimeSeconds,
    eventTimeUncertaintySeconds: bestTiming.eventTimeUncertaintySeconds,
    visibleLevel: bestTiming.visibleLevel,
    hiddenLevel: bestTiming.hiddenLevel,
    dropSignificance: bestTiming.dropSignificance,
    residualRms: bestTiming.residualRms,
    reducedChiSquared: bestTiming.reducedChiSquared,
    model: bestTiming.model,
  };
}
