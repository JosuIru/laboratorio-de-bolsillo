import {
  type CalibrationPoint,
  minimumCalibrationPointCount,
  type ScaleModel,
  scaleFeatures,
} from '@/processing/resonanceScale/massCalibration';

/** Calibración guardada: el modelo elegido y los puntos medidos (para enseñarlos y rehacerla). */
export interface ResonanceScaleCalibrationParameters {
  model: ScaleModel;
  points: CalibrationPoint[];
}

function isFiniteNumber(candidateValue: unknown): candidateValue is number {
  return typeof candidateValue === 'number' && Number.isFinite(candidateValue);
}

function isNullableFiniteNumber(candidateValue: unknown): candidateValue is number | null {
  return candidateValue === null || isFiniteNumber(candidateValue);
}

function validateScaleModel(rawModel: unknown): ScaleModel {
  const candidate = rawModel as Partial<ScaleModel> | null;
  const numericKeys = [
    'intercept',
    'slope',
    'residualStandardDeviation',
    'typicalMeasurementUncertainty',
    'pointCount',
    'meanMassGrams',
    'massSumOfSquares',
    'minimumMassGrams',
    'maximumMassGrams',
  ] as const;
  if (
    !candidate ||
    !scaleFeatures.includes(candidate.feature as ScaleModel['feature']) ||
    numericKeys.some((numericKey) => !isFiniteNumber(candidate[numericKey])) ||
    !isNullableFiniteNumber(candidate.crossValidationErrorGrams ?? null) ||
    candidate.slope === 0 ||
    candidate.pointCount! < minimumCalibrationPointCount
  ) {
    throw new Error('Modelo de la báscula de resonancia no válido');
  }
  return {
    feature: candidate.feature!,
    intercept: candidate.intercept!,
    slope: candidate.slope!,
    residualStandardDeviation: candidate.residualStandardDeviation!,
    typicalMeasurementUncertainty: candidate.typicalMeasurementUncertainty!,
    pointCount: candidate.pointCount!,
    meanMassGrams: candidate.meanMassGrams!,
    massSumOfSquares: candidate.massSumOfSquares!,
    minimumMassGrams: candidate.minimumMassGrams!,
    maximumMassGrams: candidate.maximumMassGrams!,
    crossValidationErrorGrams: candidate.crossValidationErrorGrams ?? null,
  };
}

function validateCalibrationPoint(rawPoint: unknown): CalibrationPoint {
  const candidate = rawPoint as Partial<CalibrationPoint> | null;
  if (
    !candidate ||
    !isFiniteNumber(candidate.massGrams) ||
    !isFiniteNumber(candidate.amplitudeRms) ||
    !isFiniteNumber(candidate.amplitudeSpreadRms) ||
    !isNullableFiniteNumber(candidate.peakFrequencyHz ?? null) ||
    !isNullableFiniteNumber(candidate.peakFrequencySpreadHz ?? null) ||
    !isFiniteNumber(candidate.pulseCount)
  ) {
    throw new Error('Punto de calibración no válido');
  }
  return {
    massGrams: candidate.massGrams,
    amplitudeRms: candidate.amplitudeRms,
    amplitudeSpreadRms: candidate.amplitudeSpreadRms,
    peakFrequencyHz: candidate.peakFrequencyHz ?? null,
    peakFrequencySpreadHz: candidate.peakFrequencySpreadHz ?? null,
    pulseCount: candidate.pulseCount,
  };
}

export function validateResonanceScaleCalibration(rawParameters: unknown): ResonanceScaleCalibrationParameters {
  const candidate = rawParameters as Partial<ResonanceScaleCalibrationParameters> | null;
  if (!candidate || !Array.isArray(candidate.points)) throw new Error('Calibración de la báscula no válida');
  return { model: validateScaleModel(candidate.model), points: candidate.points.map(validateCalibrationPoint) };
}
