import type { TiltAngles } from '@/processing/signal/orientation';

/** Inclinación que mide el móvil sobre una superficie que sabemos que está a nivel. */
export interface LevelCalibrationParameters {
  offsetXDegrees: number;
  offsetYDegrees: number;
}

export const defaultLevelCalibration: LevelCalibrationParameters = { offsetXDegrees: 0, offsetYDegrees: 0 };

export function validateLevelCalibration(rawParameters: unknown): LevelCalibrationParameters {
  const candidate = rawParameters as Partial<LevelCalibrationParameters> | null;
  const isValidOffset = (offset: unknown) => typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) < 45;
  if (!candidate || !isValidOffset(candidate.offsetXDegrees) || !isValidOffset(candidate.offsetYDegrees)) {
    throw new Error('Calibración de nivel no válida');
  }
  return { offsetXDegrees: candidate.offsetXDegrees!, offsetYDegrees: candidate.offsetYDegrees! };
}

export function applyLevelCalibration(
  rawTilt: TiltAngles,
  calibration: LevelCalibrationParameters | null,
): TiltAngles {
  const activeCalibration = calibration ?? defaultLevelCalibration;
  return {
    tiltXDegrees: rawTilt.tiltXDegrees - activeCalibration.offsetXDegrees,
    tiltYDegrees: rawTilt.tiltYDegrees - activeCalibration.offsetYDegrees,
  };
}
