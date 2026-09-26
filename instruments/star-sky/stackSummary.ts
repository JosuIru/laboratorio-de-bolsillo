/**
 * Cifras para enseñar del apilado (sin React): estrellas, magnitud límite aproximada y cuánto ha
 * bajado el ruido respecto a una foto suelta.
 */
import {
  expectedStackingGainMagnitudes,
  type FieldOfView,
  limitingMagnitudeFromStarCount,
  magnitudeDifference,
} from '@/processing/astronomy/starFieldStatistics';
import type { StarStackResult } from '@/processing/image/starStacking';

export interface StackSummary {
  starsInStack: number;
  starsInSingleFrame: number;
  limitingMagnitudeStack: number | null;
  limitingMagnitudeSingle: number | null;
  /** Ruido de la foto suelta / ruido del apilado (≈ √N con N fotos). */
  noiseReductionFactor: number;
  /** Ganancia teórica de magnitud límite con las fotos apiladas (2,5·log₁₀ √N). */
  expectedGainMagnitudes: number;
  /** Rango de brillos detectado en el apilado: de la más brillante a la más débil, en magnitudes. */
  detectedMagnitudeRange: number;
  /** Fotos que no se pudieron alinear. */
  unalignedFrameCount: number;
}

export function summarizeStarStack(stackResult: StarStackResult, fieldOfView: FieldOfView): StackSummary {
  const { stacked, singleFrame } = stackResult;
  const brightestFlux = stacked.stars[0]?.flux ?? 0;
  const faintestFlux = stacked.stars[stacked.stars.length - 1]?.flux ?? 0;
  return {
    starsInStack: stacked.stars.length,
    starsInSingleFrame: singleFrame.stars.length,
    limitingMagnitudeStack: limitingMagnitudeFromStarCount(stacked.stars.length, fieldOfView.solidAngleSquareDegrees),
    limitingMagnitudeSingle: limitingMagnitudeFromStarCount(singleFrame.stars.length, fieldOfView.solidAngleSquareDegrees),
    noiseReductionFactor: stacked.backgroundNoise > 0 ? singleFrame.backgroundNoise / stacked.backgroundNoise : 1,
    expectedGainMagnitudes: expectedStackingGainMagnitudes(stackResult.stackedFrameCount),
    detectedMagnitudeRange: magnitudeDifference(brightestFlux, faintestFlux),
    unalignedFrameCount: stackResult.frames.length - stackResult.stackedFrameCount,
  };
}
