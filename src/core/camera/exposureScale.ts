/**
 * Escala de la compensación de exposición de la cámara.
 *
 * En iOS, vision-camera la da en EV. En Android es un índice entero de pasos
 * (`setExposureCompensationIndex`) cuyo tamaño en EV depende del móvil (suele ser 1/6 o 1/3 EV)
 * y la librería no lo expone. Por eso en Android se muestran pasos, no EV.
 */
export interface ExposureScale {
  isStepIndex: boolean;
  minimum: number;
  maximum: number;
  /** Cuánto cambia cada pulsación de los botones. */
  increment: number;
  /** Valor con el que arranca la cámara (ver `startsDark`). */
  initialValue: number;
}

/** Pulsaciones aproximadas para recorrer todo el rango en Android. */
const pressesAcrossStepRange = 16;
const evIncrement = 0.5;
const darkStartEvBias = -2;

/**
 * `startsDark`: para objetos muy brillantes sobre fondo oscuro (la Luna), que con la exposición
 * automática salen quemados. Si no, se arranca sin compensación.
 */
export function createExposureScale(
  minimum: number,
  maximum: number,
  isStepIndex: boolean,
  startsDark = false,
): ExposureScale {
  const clampToRange = (value: number) => Math.min(maximum, Math.max(minimum, value));
  if (isStepIndex) {
    return {
      isStepIndex,
      minimum,
      maximum,
      increment: Math.max(1, Math.round((maximum - minimum) / pressesAcrossStepRange)),
      initialValue: startsDark ? minimum : clampToRange(0),
    };
  }
  return {
    isStepIndex,
    minimum,
    maximum,
    increment: evIncrement,
    initialValue: clampToRange(startsDark ? darkStartEvBias : 0),
  };
}

/** Siguiente valor al pulsar «+» (`direction` = 1) o «−» (`direction` = -1), dentro del rango. */
export function stepExposure(scale: ExposureScale, currentValue: number, direction: 1 | -1): number {
  const nextValue = currentValue + direction * scale.increment;
  const clampedValue = Math.min(scale.maximum, Math.max(scale.minimum, nextValue));
  return scale.isStepIndex ? Math.round(clampedValue) : clampedValue;
}

/** Número con signo: «+3», «−12», «0» (pasos) o «−1.5» (EV). */
export function formatExposureValue(scale: ExposureScale, value: number): string {
  const formattedMagnitude = scale.isStepIndex ? Math.abs(Math.round(value)).toString() : Math.abs(value).toFixed(1);
  if (value > 0) return `+${formattedMagnitude}`;
  if (value < 0) return `−${formattedMagnitude}`;
  return formattedMagnitude;
}
