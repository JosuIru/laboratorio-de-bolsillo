/**
 * Exposición para una ráfaga tomada a mano (lógica pura). Con poca luz, la exposición automática
 * alarga el tiempo (1/30 s o más) y cada foto sale movida por el pulso. Para la ráfaga conviene
 * acortarlo y subir el ISO en la misma proporción (la imagen queda igual de clara): el ruido que
 * añade el ISO lo quita después la fusión de varias fotos, pero lo movido no lo arregla nada.
 */

export interface CurrentExposure {
  /** Tiempo de exposición actual (el que eligió la exposición automática), en segundos. */
  exposureSeconds: number;
  iso: number;
}

export interface ExposureLimits {
  minimumExposureSeconds: number;
  maximumExposureSeconds: number;
  minimumIso: number;
  maximumIso: number;
}

export interface BurstExposurePlan {
  exposureSeconds: number;
  iso: number;
}

/** Más corto que esto el pulso ya no mueve la foto de forma apreciable (a zoom ×1-×2). */
export const handheldBurstExposureSeconds = 1 / 250;
/** Por encima de este ISO el ruido de cada foto estropea el alineado. */
export const maximumBurstIso = 1600;
/** Si el tiempo apenas se acorta, no merece la pena tocar la exposición automática. */
const minimumWorthwhileShortening = 0.8;

/**
 * Tiempo e ISO para la ráfaga con la misma luz que la exposición actual (tiempo × ISO constante),
 * acortando el tiempo hasta `targetExposureSeconds` si el ISO lo permite. Devuelve null si no se
 * gana nada (ya es corto, o el ISO ya está al máximo).
 */
export function planHandheldBurstExposure(
  currentExposure: CurrentExposure,
  exposureLimits: ExposureLimits,
  targetExposureSeconds: number = handheldBurstExposureSeconds,
  isoCeiling: number = maximumBurstIso,
): BurstExposurePlan | null {
  const { exposureSeconds: currentSeconds, iso: currentIso } = currentExposure;
  if (!(currentSeconds > 0) || !(currentIso > 0)) return null;
  const { minimumExposureSeconds, maximumExposureSeconds, minimumIso, maximumIso } = exposureLimits;
  const exposureProduct = currentSeconds * currentIso;
  // El techo de ISO no baja del que ya había: no se oscurece la imagen.
  const usableMaximumIso = Math.min(maximumIso, Math.max(isoCeiling, currentIso));
  const desiredSeconds = Math.max(minimumExposureSeconds, Math.min(currentSeconds, targetExposureSeconds));
  let plannedSeconds = desiredSeconds;
  let plannedIso = exposureProduct / desiredSeconds;
  if (plannedIso > usableMaximumIso) {
    plannedIso = usableMaximumIso;
    plannedSeconds = exposureProduct / usableMaximumIso;
  }
  plannedIso = Math.max(minimumIso, plannedIso);
  plannedSeconds = Math.min(maximumExposureSeconds, Math.max(minimumExposureSeconds, plannedSeconds));
  if (plannedSeconds > currentSeconds * minimumWorthwhileShortening) return null;
  return { exposureSeconds: plannedSeconds, iso: Math.round(plannedIso) };
}
