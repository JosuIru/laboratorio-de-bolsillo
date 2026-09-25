/**
 * Calibración de la báscula de resonancia: de rasgos de la respuesta a la vibración a gramos.
 *
 * Modelo físico sencillo: el motor empuja con una fuerza casi fija a una frecuencia muy por
 * encima de la resonancia del móvil sobre la esponja. En ese régimen manda la inercia y la
 * aceleración vale a ≈ F / (M + m): la inversa de la amplitud crece en línea recta con la masa
 * añadida. También se prueba un ajuste lineal de la frecuencia del pico frente a la masa (en
 * algunos móviles el motor se frena un poco con la carga). Se elige el rasgo que mejor predice
 * las masas de calibración dejando cada una fuera del ajuste (validación cruzada).
 */

import type { PulseResponseAnalysis } from './pulseResponse';

export type ScaleFeature = 'inverse-amplitude' | 'peak-frequency';

export const scaleFeatures: readonly ScaleFeature[] = ['inverse-amplitude', 'peak-frequency'];

/** Lo que interesa de una medida (los mismos campos que da el análisis de pulsos). */
export interface ResponseMeasurement {
  amplitudeRms: number;
  amplitudeSpreadRms: number;
  peakFrequencyHz: number | null;
  peakFrequencySpreadHz: number | null;
  pulseCount: number;
}

export function responseMeasurementFromAnalysis(analysis: PulseResponseAnalysis): ResponseMeasurement {
  return {
    amplitudeRms: analysis.amplitudeRms,
    amplitudeSpreadRms: analysis.amplitudeSpreadRms,
    peakFrequencyHz: analysis.peakFrequencyHz,
    peakFrequencySpreadHz: analysis.peakFrequencySpreadHz,
    pulseCount: analysis.pulses.length,
  };
}

export interface CalibrationPoint extends ResponseMeasurement {
  massGrams: number;
}

export interface ScaleModel {
  feature: ScaleFeature;
  /** rasgo = intercept + slope · masa (masa en gramos). */
  intercept: number;
  slope: number;
  /** Dispersión de los puntos de calibración alrededor de la recta, en unidades del rasgo. */
  residualStandardDeviation: number;
  /** Incertidumbre típica de una sola medida (entre pulsos), en unidades del rasgo. */
  typicalMeasurementUncertainty: number;
  pointCount: number;
  meanMassGrams: number;
  massSumOfSquares: number;
  minimumMassGrams: number;
  maximumMassGrams: number;
  /** Error cuadrático medio al predecir cada punto sin usarlo en el ajuste (g), si hay ≥ 3. */
  crossValidationErrorGrams: number | null;
}

export interface MassEstimate {
  massGrams: number;
  /** Incertidumbre típica (1σ) en gramos. */
  standardUncertaintyGrams: number;
  /** Intervalo aproximado del 95 % (2σ). */
  expandedUncertaintyGrams: number;
  /** La masa cae fuera del rango calibrado (más allá de un margen). */
  isExtrapolated: boolean;
}

export const minimumCalibrationPointCount = 3;
export const minimumCalibrationMassSpanGrams = 5;

/** Monedas de euro: masas oficiales del BCE. */
export const euroCoinMassesGrams = {
  oneEuro: 7.5,
  twoEuros: 8.5,
  fiftyCents: 7.8,
} as const;

export type EuroCoin = keyof typeof euroCoinMassesGrams;

export function massOfCoins(coinCounts: Partial<Record<EuroCoin, number>>): number {
  let totalGrams = 0;
  for (const [coin, coinCount] of Object.entries(coinCounts) as [EuroCoin, number][]) {
    totalGrams += euroCoinMassesGrams[coin] * coinCount;
  }
  return Math.round(totalGrams * 10) / 10;
}

/** Valor del rasgo para una medida, o null si no se puede calcular. */
export function featureValue(feature: ScaleFeature, measurement: ResponseMeasurement): number | null {
  if (feature === 'inverse-amplitude') {
    return measurement.amplitudeRms > 0 ? 1 / measurement.amplitudeRms : null;
  }
  return measurement.peakFrequencyHz;
}

/** Incertidumbre típica del rasgo de una medida (error de la media de los pulsos). */
export function featureUncertainty(feature: ScaleFeature, measurement: ResponseMeasurement): number | null {
  const pulseCountRoot = Math.sqrt(Math.max(1, measurement.pulseCount));
  if (feature === 'inverse-amplitude') {
    if (!(measurement.amplitudeRms > 0)) return null;
    // Propagación: d(1/A) = dA / A².
    return measurement.amplitudeSpreadRms / measurement.amplitudeRms ** 2 / pulseCountRoot;
  }
  return measurement.peakFrequencySpreadHz === null ? null : measurement.peakFrequencySpreadHz / pulseCountRoot;
}

interface LinearFit {
  intercept: number;
  slope: number;
  residualStandardDeviation: number;
  meanX: number;
  sumOfSquaresX: number;
}

/** Mínimos cuadrados ordinarios. Devuelve null si todas las x son iguales. */
export function fitStraightLine(xValues: readonly number[], yValues: readonly number[]): LinearFit | null {
  const pointCount = xValues.length;
  if (pointCount < 2 || yValues.length !== pointCount) return null;
  const meanX = xValues.reduce((sum, xValue) => sum + xValue, 0) / pointCount;
  const meanY = yValues.reduce((sum, yValue) => sum + yValue, 0) / pointCount;
  let sumOfSquaresX = 0;
  let sumOfCrossProducts = 0;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    sumOfSquaresX += (xValues[pointIndex]! - meanX) ** 2;
    sumOfCrossProducts += (xValues[pointIndex]! - meanX) * (yValues[pointIndex]! - meanY);
  }
  if (sumOfSquaresX <= 0) return null;
  const slope = sumOfCrossProducts / sumOfSquaresX;
  const intercept = meanY - slope * meanX;
  let residualSumOfSquares = 0;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    residualSumOfSquares += (yValues[pointIndex]! - intercept - slope * xValues[pointIndex]!) ** 2;
  }
  const degreesOfFreedom = pointCount - 2;
  return {
    intercept,
    slope,
    residualStandardDeviation: degreesOfFreedom > 0 ? Math.sqrt(residualSumOfSquares / degreesOfFreedom) : 0,
    meanX,
    sumOfSquaresX,
  };
}

function usablePoints(points: readonly CalibrationPoint[], feature: ScaleFeature) {
  return points.flatMap((point) => {
    const pointFeatureValue = featureValue(feature, point);
    return pointFeatureValue === null || !Number.isFinite(pointFeatureValue)
      ? []
      : [{ massGrams: point.massGrams, featureValue: pointFeatureValue, point }];
  });
}

function crossValidationError(points: readonly { massGrams: number; featureValue: number }[]): number | null {
  if (points.length < 3) return null;
  let squaredErrorSum = 0;
  for (let leftOutIndex = 0; leftOutIndex < points.length; leftOutIndex++) {
    const trainingPoints = points.filter((_, pointIndex) => pointIndex !== leftOutIndex);
    const trainingFit = fitStraightLine(
      trainingPoints.map((point) => point.massGrams),
      trainingPoints.map((point) => point.featureValue),
    );
    if (!trainingFit || trainingFit.slope === 0) return null;
    const leftOutPoint = points[leftOutIndex]!;
    const predictedMass = (leftOutPoint.featureValue - trainingFit.intercept) / trainingFit.slope;
    squaredErrorSum += (predictedMass - leftOutPoint.massGrams) ** 2;
  }
  return Math.sqrt(squaredErrorSum / points.length);
}

/**
 * Ajusta un rasgo frente a la masa. Devuelve null si no hay datos suficientes o si el rasgo no
 * cambia de forma distinguible del ruido dentro del rango calibrado.
 */
export function buildScaleModel(points: readonly CalibrationPoint[], feature: ScaleFeature): ScaleModel | null {
  const featurePoints = usablePoints(points, feature);
  if (featurePoints.length < minimumCalibrationPointCount) return null;
  const masses = featurePoints.map((featurePoint) => featurePoint.massGrams);
  const minimumMassGrams = Math.min(...masses);
  const maximumMassGrams = Math.max(...masses);
  if (maximumMassGrams - minimumMassGrams < minimumCalibrationMassSpanGrams) return null;

  const linearFit = fitStraightLine(
    masses,
    featurePoints.map((featurePoint) => featurePoint.featureValue),
  );
  if (!linearFit) return null;
  // Más masa debe dar menos amplitud: una pendiente negativa en 1/A no tiene sentido físico.
  if (feature === 'inverse-amplitude' && linearFit.slope <= 0) return null;

  const measurementUncertainties = featurePoints.flatMap((featurePoint) => {
    const pointUncertainty = featureUncertainty(feature, featurePoint.point);
    return pointUncertainty === null ? [] : [pointUncertainty];
  });
  const typicalMeasurementUncertainty =
    measurementUncertainties.length > 0
      ? Math.sqrt(
          measurementUncertainties.reduce((sum, uncertainty) => sum + uncertainty ** 2, 0) /
            measurementUncertainties.length,
        )
      : 0;

  // El cambio del rasgo en todo el rango debe superar claramente el ruido.
  const featureChangeAcrossRange = Math.abs(linearFit.slope) * (maximumMassGrams - minimumMassGrams);
  const noiseLevel = Math.max(linearFit.residualStandardDeviation, typicalMeasurementUncertainty);
  if (!(featureChangeAcrossRange > 2 * noiseLevel)) return null;

  return {
    feature,
    intercept: linearFit.intercept,
    slope: linearFit.slope,
    residualStandardDeviation: linearFit.residualStandardDeviation,
    typicalMeasurementUncertainty,
    pointCount: featurePoints.length,
    meanMassGrams: linearFit.meanX,
    massSumOfSquares: linearFit.sumOfSquaresX,
    minimumMassGrams,
    maximumMassGrams,
    crossValidationErrorGrams: crossValidationError(featurePoints),
  };
}

export interface CalibrationFitResult {
  bestModel: ScaleModel | null;
  candidateModels: ScaleModel[];
}

/** Ajusta todos los rasgos y se queda con el de menor error de validación cruzada. */
export function fitCalibration(points: readonly CalibrationPoint[]): CalibrationFitResult {
  const candidateModels = scaleFeatures.flatMap((feature) => {
    const scaleModel = buildScaleModel(points, feature);
    return scaleModel ? [scaleModel] : [];
  });
  const modelScore = (scaleModel: ScaleModel) =>
    scaleModel.crossValidationErrorGrams ?? Number.POSITIVE_INFINITY;
  // En caso de empate gana la amplitud, que tiene respaldo físico (va primera en la lista).
  const bestModel = candidateModels.reduce<ScaleModel | null>(
    (currentBest, candidateModel) =>
      currentBest === null || modelScore(candidateModel) < modelScore(currentBest) ? candidateModel : currentBest,
    null,
  );
  return { bestModel, candidateModels };
}

/**
 * Desplazamiento de «tara»: cuánto se ha movido el rasgo con el móvil vacío respecto a la
 * calibración (la esponja se aplasta, el móvil no queda en el mismo sitio…).
 */
export function computeTareOffset(scaleModel: ScaleModel, emptyMeasurement: ResponseMeasurement): number | null {
  const emptyFeatureValue = featureValue(scaleModel.feature, emptyMeasurement);
  return emptyFeatureValue === null ? null : emptyFeatureValue - scaleModel.intercept;
}

/**
 * Masa a partir de una medida, con su incertidumbre (predicción inversa de una recta de
 * calibración). La dispersión entre colocaciones se toma del ajuste, pero nunca por debajo de
 * la repetibilidad entre pulsos: con tres puntos el residuo puede salir casualmente casi cero.
 */
export function estimateMass(
  scaleModel: ScaleModel,
  measurement: ResponseMeasurement,
  tareOffset = 0,
): MassEstimate | null {
  const measuredFeatureValue = featureValue(scaleModel.feature, measurement);
  if (measuredFeatureValue === null || scaleModel.slope === 0) return null;
  const massGrams = (measuredFeatureValue - tareOffset - scaleModel.intercept) / scaleModel.slope;

  const placementScatter = Math.max(scaleModel.residualStandardDeviation, scaleModel.typicalMeasurementUncertainty);
  const currentMeasurementUncertainty = featureUncertainty(scaleModel.feature, measurement) ?? 0;
  const calibrationLineVariance =
    placementScatter ** 2 *
    (1 / scaleModel.pointCount +
      (scaleModel.massSumOfSquares > 0 ? (massGrams - scaleModel.meanMassGrams) ** 2 / scaleModel.massSumOfSquares : 0));
  const featureVariance = placementScatter ** 2 + currentMeasurementUncertainty ** 2 + calibrationLineVariance;
  const standardUncertaintyGrams = Math.sqrt(featureVariance) / Math.abs(scaleModel.slope);

  const calibratedSpanGrams = scaleModel.maximumMassGrams - scaleModel.minimumMassGrams;
  const extrapolationMarginGrams = 0.25 * calibratedSpanGrams;
  return {
    massGrams,
    standardUncertaintyGrams,
    expandedUncertaintyGrams: 2 * standardUncertaintyGrams,
    isExtrapolated:
      massGrams < scaleModel.minimumMassGrams - extrapolationMarginGrams ||
      massGrams > scaleModel.maximumMassGrams + extrapolationMarginGrams,
  };
}

/** Sensibilidad legible: cuánto cambia la amplitud (en %) por cada 10 g, cerca del vacío. */
export function amplitudeChangePercentPerTenGrams(scaleModel: ScaleModel): number | null {
  if (scaleModel.feature !== 'inverse-amplitude' || scaleModel.intercept <= 0) return null;
  // A(m) = 1 / (a + b·m) ⇒ A(10)/A(0) − 1 = a / (a + 10 b) − 1.
  return (scaleModel.intercept / (scaleModel.intercept + 10 * scaleModel.slope) - 1) * 100;
}

/** Repetibilidad de una medida (dispersión relativa de la amplitud entre pulsos). */
export function relativeAmplitudeSpread(measurement: ResponseMeasurement): number {
  return measurement.amplitudeRms > 0 ? measurement.amplitudeSpreadRms / measurement.amplitudeRms : Number.POSITIVE_INFINITY;
}
