/**
 * Exposición manual para la Luna: un objeto muy brillante sobre cielo negro.
 *
 * La exposición automática mide sobre todo el cielo y sube el tiempo y el ISO al máximo; con la
 * compensación (±6 EV como mucho) la Luna sigue quemada. Con el tiempo de exposición fijo se ajusta
 * midiendo solo la Luna: se busca el brillo más alto posible sin que se saturen sus píxeles.
 */

/** Rango de tiempos de exposición que admite el sensor, en segundos. */
export interface ExposureDurationRange {
  minimumSeconds: number;
  maximumSeconds: number;
}

/** Brillo de la Luna medido en un fotograma (ver `BrightObjectDetection`). */
export interface LunarBrightnessReading {
  /** Brillo máximo (suma R+G+B, 0-765). */
  peakBrightness: number;
  /** Fracción de la Luna con algún canal saturado. */
  saturatedFraction: number;
}

/**
 * Punto de partida con ISO bajo: regla «Looney 11» (f/11, 1/ISO para la Luna llena) llevada a un
 * objetivo de móvil de f/1,8, con un paso de margen para las fases con menos luz.
 */
export const initialLunarExposureSeconds = 1 / 2000;

/** Un tercio de paso: el incremento de los botones y del ajuste fino. */
export const exposureThirdStopFactor = 2 ** (1 / 3);

/** Por encima de esta fracción saturada, la Luna está muy quemada: se baja un paso entero. */
const heavilySaturatedFraction = 0.1;
/** Por encima de esta fracción saturada se pierden detalles en las zonas más claras. */
const slightlySaturatedFraction = 0.005;
/** Por debajo de este brillo máximo la Luna está muy oscura: se sube un paso entero. */
const veryDarkPeakBrightness = 400;
/**
 * Por debajo de este brillo máximo se sube un tercio. Entre este valor y la saturación (750) hay
 * más de medio paso, para que el ajuste de un tercio no oscile.
 */
const targetMinimumPeakBrightness = 520;

export function clampExposureDuration(exposureSeconds: number, durationRange: ExposureDurationRange): number {
  return Math.min(durationRange.maximumSeconds, Math.max(durationRange.minimumSeconds, exposureSeconds));
}

/**
 * Siguiente tiempo de exposición para que la Luna quede lo más clara posible sin saturarse.
 * Devuelve el mismo valor si ya está bien expuesta (o si no se puede ajustar más).
 */
export function nextLunarExposureSeconds(
  currentExposureSeconds: number,
  brightnessReading: LunarBrightnessReading,
  durationRange: ExposureDurationRange,
): number {
  const { peakBrightness, saturatedFraction } = brightnessReading;
  let exposureFactor = 1;
  if (saturatedFraction > heavilySaturatedFraction) exposureFactor = 1 / 2;
  else if (saturatedFraction > slightlySaturatedFraction) exposureFactor = 1 / exposureThirdStopFactor;
  else if (peakBrightness < veryDarkPeakBrightness) exposureFactor = 2;
  else if (peakBrightness < targetMinimumPeakBrightness) exposureFactor = exposureThirdStopFactor;
  return clampExposureDuration(currentExposureSeconds * exposureFactor, durationRange);
}

/** Tiempo de exposición legible: «1/2000 s», «1/8 s», «0,5 s». */
export function formatExposureDuration(exposureSeconds: number): string {
  if (exposureSeconds >= 0.3) return `${exposureSeconds.toFixed(1).replace('.', ',')} s`;
  const reciprocal = 1 / exposureSeconds;
  const roundedReciprocal = reciprocal >= 100 ? Math.round(reciprocal / 10) * 10 : Math.round(reciprocal);
  return `1/${roundedReciprocal} s`;
}
