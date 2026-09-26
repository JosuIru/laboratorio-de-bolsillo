/**
 * «Cámara fijada» para los instrumentos que miden color: exposición manual (tiempo e ISO) que deja
 * la zona de referencia (la tarjeta blanca, el papel o el pico más brillante del espectro) clara
 * pero sin saturar, y que ya no cambia entre una lectura y otra.
 *
 * En Android (parche propio de VisionCamera) no se puede leer la exposición que ha elegido el
 * automático: `exposureDuration` e `iso` valen 0 hasta que se fijan a mano. Así que se parte de un
 * valor razonable y se ajusta por pasos, midiendo el brillo de la zona de referencia en los
 * fotogramas (como la Luna con `lunarExposure.ts`). Todo aquí es puro, sin React ni cámara.
 */

/** Tiempo de exposición e ISO fijos. */
export interface ManualExposure {
  durationSeconds: number;
  iso: number;
}

/** Rangos que admite el sensor. */
export interface ManualExposureLimits {
  minimumDurationSeconds: number;
  maximumDurationSeconds: number;
  minimumIso: number;
  maximumIso: number;
}

/** Lo que la cámara dice que sabe hacer (ver `CameraDevice` y `CameraController`). */
export interface CameraLockCapabilities {
  supportsExposureLocking: boolean;
  supportsWhiteBalanceLocking: boolean;
  minimumDurationSeconds: number;
  maximumDurationSeconds: number;
  minimumIso: number;
  maximumIso: number;
}

export interface CameraLockPlan {
  canLockWhiteBalance: boolean;
  /** Límites del sensor, o null si no se puede fijar la exposición. */
  exposureLimits: ManualExposureLimits | null;
  /** Se puede fijar algo: si no, la cámara sigue en automático como siempre. */
  isSupported: boolean;
}

/**
 * Qué se puede fijar. La exposición manual necesita los rangos del sensor (en Android solo se
 * conocen con la cámara arrancada); sin ellos no se intenta.
 */
export function planCameraLock(capabilities: CameraLockCapabilities): CameraLockPlan {
  const hasUsableExposureRanges =
    capabilities.minimumDurationSeconds > 0 &&
    capabilities.maximumDurationSeconds >= capabilities.minimumDurationSeconds &&
    capabilities.minimumIso > 0 &&
    capabilities.maximumIso >= capabilities.minimumIso;
  const exposureLimits =
    capabilities.supportsExposureLocking && hasUsableExposureRanges
      ? {
          minimumDurationSeconds: capabilities.minimumDurationSeconds,
          maximumDurationSeconds: capabilities.maximumDurationSeconds,
          minimumIso: capabilities.minimumIso,
          maximumIso: capabilities.maximumIso,
        }
      : null;
  return {
    canLockWhiteBalance: capabilities.supportsWhiteBalanceLocking,
    exposureLimits,
    isSupported: capabilities.supportsWhiteBalanceLocking || exposureLimits !== null,
  };
}

/**
 * Con luces de red (50 Hz en Europa) el brillo parpadea 100 veces por segundo: con tiempos que son
 * múltiplos de 1/100 s cada fotograma recoge ciclos enteros y el brillo no cambia de uno a otro.
 */
export const flickerFreeDurationStepSeconds = 1 / 100;
/** Más de ~1/30 s a pulso mueve la imagen; antes se sube el ISO. */
export const handheldMaximumDurationSeconds = 3 / 100;

function clampValue(value: number, minimumValue: number, maximumValue: number): number {
  return Math.min(maximumValue, Math.max(minimumValue, value));
}

/**
 * Reparte una exposición total (tiempo × ISO) entre tiempo e ISO: ISO mínimo (menos ruido) con
 * tiempos cortos; con poca luz, tiempos múltiplos de 1/100 s hasta ~1/30 s y el ISO completa; si
 * aún falta, ISO máximo y tiempo más largo.
 */
export function splitExposureProduct(exposureProduct: number, limits: ManualExposureLimits): ManualExposure {
  const clampDuration = (durationSeconds: number) =>
    clampValue(durationSeconds, limits.minimumDurationSeconds, limits.maximumDurationSeconds);
  const clampIso = (iso: number) => clampValue(Math.round(iso), limits.minimumIso, limits.maximumIso);

  const durationAtMinimumIso = exposureProduct / limits.minimumIso;
  if (durationAtMinimumIso < flickerFreeDurationStepSeconds) {
    return { durationSeconds: clampDuration(durationAtMinimumIso), iso: limits.minimumIso };
  }
  const flickerFreeStepCount = Math.min(
    Math.floor(durationAtMinimumIso / flickerFreeDurationStepSeconds + 1e-9),
    Math.round(handheldMaximumDurationSeconds / flickerFreeDurationStepSeconds),
  );
  const flickerFreeDuration = clampDuration(flickerFreeStepCount * flickerFreeDurationStepSeconds);
  const isoForFlickerFreeDuration = exposureProduct / flickerFreeDuration;
  if (isoForFlickerFreeDuration <= limits.maximumIso) {
    return { durationSeconds: flickerFreeDuration, iso: clampIso(isoForFlickerFreeDuration) };
  }
  return { durationSeconds: clampDuration(exposureProduct / limits.maximumIso), iso: limits.maximumIso };
}

/**
 * Punto de partida. Si la cámara dice qué exposición usa (iOS, o ya fijada a mano) se parte de
 * ella; si no (Android en automático), de 1/50 s a ISO 200, lo típico en interior: el ajuste por
 * pasos llega desde ahí a exteriores en tres o cuatro pasos.
 */
export function initialManualExposure(
  reportedExposure: ManualExposure | null,
  limits: ManualExposureLimits,
): ManualExposure {
  if (reportedExposure && reportedExposure.durationSeconds > 0 && reportedExposure.iso > 0) {
    return splitExposureProduct(reportedExposure.durationSeconds * reportedExposure.iso, limits);
  }
  return splitExposureProduct((1 / 50) * 200, limits);
}

/** Brillo de la zona de referencia en un fotograma (o en la media de unos pocos). */
export interface ReferenceBrightnessReading {
  /** Canal más brillante de la zona, en luz lineal (0-1). */
  brightestChannelLinear: number;
  /** Fracción de la zona con algún píxel a 255, si se sabe (si no, 0). */
  saturatedFraction: number;
}

/** Brillo que se busca para la zona de referencia, en luz lineal. */
export interface ExposureTargetBand {
  minimumLinear: number;
  maximumLinear: number;
  /** Fracción saturada que se tolera. */
  maximumSaturatedFraction: number;
}

/**
 * Tarjeta blanca o papel: entre ~0,55 y ~0,82 en lineal (≈ 195-235 en 8 bits con gamma): clara,
 * con margen hasta el recorte aunque la luz suba un poco.
 */
export const whiteReferenceTargetBand: ExposureTargetBand = {
  minimumLinear: 0.55,
  maximumLinear: 0.82,
  maximumSaturatedFraction: 0.005,
};

/**
 * Pico más brillante del espectro: algo más bajo que el blanco (una línea estrecha tiene píxeles
 * más brillantes que la media de la tira que se mide) y sin ningún punto saturado.
 */
export const spectrumPeakTargetBand: ExposureTargetBand = {
  minimumLinear: 0.4,
  maximumLinear: 0.8,
  maximumSaturatedFraction: 0,
};

/** Por encima de este brillo lineal medio la zona está recortada aunque no se sepa qué fracción. */
const saturatedMeanLinear = 0.96;
/** Por debajo casi no hay señal: el cálculo proporcional no es fiable y se sube mucho. */
const nearlyBlackLinear = 0.01;
/** Paso máximo en cada ajuste (4 pasos de diafragma). */
const maximumStepFactor = 16;
/** Con la zona saturada no se sabe cuánto sobra: se bajan 2 pasos. */
const saturatedStepFactor = 1 / 4;
/** Intentos antes de rendirse (con la última exposición sin saturar). */
export const maximumExposureAdjustments = 10;

export type ExposureSearchOutcome = 'adjusting' | 'converged' | 'limitReached' | 'gaveUp';

export interface ExposureSearchState {
  exposure: ManualExposure;
  /** Menor tiempo × ISO con el que la referencia salió saturada (tope para subir). */
  saturatingProduct: number | null;
  /** Mayor tiempo × ISO con el que salió demasiado oscura (suelo para bajar). */
  tooDarkProduct: number | null;
  adjustmentCount: number;
  outcome: ExposureSearchOutcome;
}

export function startExposureSearch(initialExposure: ManualExposure): ExposureSearchState {
  return { exposure: initialExposure, saturatingProduct: null, tooDarkProduct: null, adjustmentCount: 0, outcome: 'adjusting' };
}

export function isReadingSaturated(reading: ReferenceBrightnessReading, targetBand: ExposureTargetBand): boolean {
  return reading.saturatedFraction > targetBand.maximumSaturatedFraction || reading.brightestChannelLinear >= saturatedMeanLinear;
}

function exposureProductOf(exposure: ManualExposure): number {
  return exposure.durationSeconds * exposure.iso;
}

function isSameExposure(firstExposure: ManualExposure, secondExposure: ManualExposure): boolean {
  return (
    Math.abs(firstExposure.durationSeconds - secondExposure.durationSeconds) <= firstExposure.durationSeconds * 1e-6 &&
    firstExposure.iso === secondExposure.iso
  );
}

/**
 * Un paso del ajuste: con el brillo medido a la exposición actual, propone la siguiente. La
 * respuesta del sensor es lineal, así que el factor es «brillo buscado / brillo medido»; si está
 * saturada, se baja un paso y medio. Recuerda lo que saturó y lo que salió oscuro para no volver a
 * pasarse (búsqueda acotada, como una bisección).
 */
export function advanceExposureSearch(
  searchState: ExposureSearchState,
  reading: ReferenceBrightnessReading,
  limits: ManualExposureLimits,
  targetBand: ExposureTargetBand,
): ExposureSearchState {
  if (searchState.outcome !== 'adjusting') return searchState;
  const currentProduct = exposureProductOf(searchState.exposure);
  const isSaturated = isReadingSaturated(reading, targetBand);
  const isTooDark = !isSaturated && reading.brightestChannelLinear < targetBand.minimumLinear;
  const isTooBright = !isSaturated && reading.brightestChannelLinear > targetBand.maximumLinear;
  if (!isSaturated && !isTooDark && !isTooBright) return { ...searchState, outcome: 'converged' };

  const saturatingProduct = isSaturated
    ? Math.min(searchState.saturatingProduct ?? Infinity, currentProduct)
    : searchState.saturatingProduct;
  const tooDarkProduct = isTooDark ? Math.max(searchState.tooDarkProduct ?? 0, currentProduct) : searchState.tooDarkProduct;

  let stepFactor: number;
  if (isSaturated) stepFactor = saturatedStepFactor;
  else if (reading.brightestChannelLinear < nearlyBlackLinear) stepFactor = maximumStepFactor;
  else {
    const targetLinear = (targetBand.minimumLinear + targetBand.maximumLinear) / 2;
    stepFactor = clampValue(targetLinear / reading.brightestChannelLinear, 1 / maximumStepFactor, maximumStepFactor);
  }
  let proposedProduct = currentProduct * stepFactor;
  // No volver a lo que ya se sabe que satura ni a lo que ya se sabe que queda oscuro.
  if (saturatingProduct !== null && proposedProduct >= saturatingProduct) {
    proposedProduct = tooDarkProduct !== null ? Math.sqrt(tooDarkProduct * saturatingProduct) : saturatingProduct * saturatedStepFactor;
  }
  if (tooDarkProduct !== null && proposedProduct <= tooDarkProduct) {
    proposedProduct = saturatingProduct !== null ? Math.sqrt(tooDarkProduct * saturatingProduct) : tooDarkProduct * 2;
  }

  const nextExposure = splitExposureProduct(proposedProduct, limits);
  const adjustmentCount = searchState.adjustmentCount + 1;
  const nextState = { exposure: nextExposure, saturatingProduct, tooDarkProduct, adjustmentCount };
  if (isSameExposure(nextExposure, searchState.exposure)) {
    // El sensor no da más de sí (o la búsqueda ya no puede afinar más): se queda así.
    return { ...nextState, outcome: 'limitReached' };
  }
  if (adjustmentCount >= maximumExposureAdjustments) {
    // Se rinde con una exposición que no satura: la más alta que se sabe oscura, o la propuesta.
    const safeExposure = tooDarkProduct !== null && isSaturated ? splitExposureProduct(tooDarkProduct, limits) : nextExposure;
    return { ...nextState, exposure: safeExposure, outcome: 'gaveUp' };
  }
  return { ...nextState, outcome: 'adjusting' };
}

/** Lectura de brillo de una región medida (media lineal por canal). */
export function brightnessReadingFromLinearMean(meanLinear: { red: number; green: number; blue: number }): ReferenceBrightnessReading {
  return { brightestChannelLinear: Math.max(meanLinear.red, meanLinear.green, meanLinear.blue), saturatedFraction: 0 };
}
