import type { HardIronOffset } from '@/processing/magnetics/magneticField';

/** Campo propio del móvil (hard iron), en µT, que se resta de cada lectura. */
export type MetalDetectorCalibrationParameters = HardIronOffset;

/**
 * Un offset hard-iron real ronda las decenas o pocos cientos de µT. Por encima de 2000 µT el
 * perfil está corrupto o se calibró junto a un imán.
 */
const maximumPlausibleOffsetMicroteslas = 2000;

export function validateMetalDetectorCalibration(rawParameters: unknown): MetalDetectorCalibrationParameters {
  const candidate = rawParameters as Partial<MetalDetectorCalibrationParameters> | null;
  const isValidOffset = (offset: unknown) =>
    typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) <= maximumPlausibleOffsetMicroteslas;
  if (!candidate || !isValidOffset(candidate.offsetX) || !isValidOffset(candidate.offsetY) || !isValidOffset(candidate.offsetZ)) {
    throw new Error('Calibración del detector de metales no válida');
  }
  return { offsetX: candidate.offsetX!, offsetY: candidate.offsetY!, offsetZ: candidate.offsetZ! };
}
