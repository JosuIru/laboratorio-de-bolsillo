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
  /** Valor inicial: la Luna es muy brillante y casi siempre sale quemada. */
  initialValue: number;
}

/** Pulsaciones aproximadas para recorrer todo el rango en Android. */
const pressesAcrossStepRange = 16;
const evIncrement = 0.5;
const initialEvBias = -2;

export function createExposureScale(minimum: number, maximum: number, isStepIndex: boolean): ExposureScale {
  if (isStepIndex) {
    return {
      isStepIndex,
      minimum,
      maximum,
      increment: Math.max(1, Math.round((maximum - minimum) / pressesAcrossStepRange)),
      initialValue: minimum,
    };
  }
  return { isStepIndex, minimum, maximum, increment: evIncrement, initialValue: Math.max(minimum, initialEvBias) };
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
