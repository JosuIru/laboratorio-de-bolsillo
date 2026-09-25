/**
 * Calibración de nivel: diferencia entre lo que marca un sonómetro de referencia y el nivel en
 * dBFS que mide el móvil en ese momento. Con ella, dB SPL ≈ dBFS + desplazamiento.
 * Sin calibrar, la app solo muestra dBFS (nivel relativo al máximo del micrófono).
 */
export interface SoundLevelCalibrationParameters {
  decibelOffset: number;
}

/** Márgenes físicamente razonables para micrófonos de móvil. */
const minimumPlausibleOffset = 60;
const maximumPlausibleOffset = 160;

export function computeDecibelOffset(referenceLevelDecibels: number, measuredDecibelsFullScale: number): number {
  return referenceLevelDecibels - measuredDecibelsFullScale;
}

export function validateSoundLevelCalibration(rawParameters: unknown): SoundLevelCalibrationParameters {
  const decibelOffset = (rawParameters as Partial<SoundLevelCalibrationParameters> | null)?.decibelOffset;
  if (
    typeof decibelOffset !== 'number' ||
    !Number.isFinite(decibelOffset) ||
    decibelOffset < minimumPlausibleOffset ||
    decibelOffset > maximumPlausibleOffset
  ) {
    throw new Error('Calibración de nivel no válida');
  }
  return { decibelOffset };
}
