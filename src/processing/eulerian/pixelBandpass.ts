import { type BiquadCoefficients, designBiquad } from '@/processing/dsp/biquad';

/**
 * Filtro temporal pasabanda aplicado a cada valor de una rejilla (cada píxel y canal), como en
 * la amplificación euleriana: la serie temporal de cada píxel se filtra por separado.
 *
 * Es un Butterworth de cuarto orden por cada lado: paso alto en la frecuencia inferior y paso
 * bajo en la superior, cada uno con dos biquads (Q = 0,541 y 1,307). Los coeficientes salen de
 * `designBiquad` y la recurrencia es la misma que `processBiquadSample` (forma directa II
 * transpuesta), pero con el estado de todos los píxeles en un único array tipado.
 */

/** Q de las dos secciones de un Butterworth de 4.º orden. */
const fourthOrderButterworthQualities = [0.5411961, 1.3065630];

export interface PixelBandpassFilter {
  valueCount: number;
  lowCutoffHz: number;
  highCutoffHz: number;
  sampleRateHz: number;
  sections: BiquadCoefficients[];
  /** Dos retardos por sección y valor: `[valor][sección][retardo]`. */
  delayState: Float64Array;
  isPrimed: boolean;
}

/**
 * Crea un pasabanda para `valueCount` series temporales muestreadas a `sampleRateHz`. La
 * frecuencia superior se limita al 45 % de la de muestreo (debe quedar por debajo de Nyquist).
 */
export function createPixelBandpassFilter(
  valueCount: number,
  lowCutoffHz: number,
  highCutoffHz: number,
  sampleRateHz: number,
): PixelBandpassFilter {
  const limitedHighCutoffHz = Math.min(highCutoffHz, 0.45 * sampleRateHz);
  if (!(lowCutoffHz > 0 && lowCutoffHz < limitedHighCutoffHz)) {
    throw new RangeError(
      `Banda no válida: ${lowCutoffHz}–${highCutoffHz} Hz con ${sampleRateHz.toFixed(1)} fotogramas/s`,
    );
  }
  const sections = [
    ...fourthOrderButterworthQualities.map((quality) => designBiquad('high-pass', lowCutoffHz, sampleRateHz, quality)),
    ...fourthOrderButterworthQualities.map((quality) =>
      designBiquad('low-pass', limitedHighCutoffHz, sampleRateHz, quality),
    ),
  ];
  return {
    valueCount,
    lowCutoffHz,
    highCutoffHz: limitedHighCutoffHz,
    sampleRateHz,
    sections,
    delayState: new Float64Array(valueCount * sections.length * 2),
    isPrimed: false,
  };
}

function directCurrentGain(coefficients: BiquadCoefficients): number {
  return (coefficients.b0 + coefficients.b1 + coefficients.b2) / (1 + coefficients.a1 + coefficients.a2);
}

/**
 * Pone el estado como si cada serie llevara mucho tiempo constante en su valor actual: así el
 * primer fotograma no provoca un escalón enorme (el paso alto vería un salto desde 0).
 */
function primeFilterWith(filter: PixelBandpassFilter, inputValues: ArrayLike<number>): void {
  const sectionCount = filter.sections.length;
  for (let valueIndex = 0; valueIndex < filter.valueCount; valueIndex++) {
    let sectionInput = inputValues[valueIndex]!;
    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
      const coefficients = filter.sections[sectionIndex]!;
      const sectionOutput = directCurrentGain(coefficients) * sectionInput;
      const stateStart = (valueIndex * sectionCount + sectionIndex) * 2;
      filter.delayState[stateStart] = sectionOutput - coefficients.b0 * sectionInput;
      filter.delayState[stateStart + 1] = coefficients.b2 * sectionInput - coefficients.a2 * sectionOutput;
      sectionInput = sectionOutput;
    }
  }
  filter.isPrimed = true;
}

/**
 * Filtra un fotograma: `outputValues[i]` es la salida del pasabanda para la serie `i`. El
 * primer fotograma solo inicializa el estado (su salida es 0).
 */
export function filterPixelFrame(
  filter: PixelBandpassFilter,
  inputValues: ArrayLike<number>,
  outputValues: Float32Array | Float64Array,
): void {
  if (inputValues.length < filter.valueCount || outputValues.length < filter.valueCount) {
    throw new RangeError(`Se esperaban ${filter.valueCount} valores por fotograma`);
  }
  if (!filter.isPrimed) {
    primeFilterWith(filter, inputValues);
    outputValues.fill(0, 0, filter.valueCount);
    return;
  }
  const { sections, delayState } = filter;
  const sectionCount = sections.length;
  for (let valueIndex = 0; valueIndex < filter.valueCount; valueIndex++) {
    let sectionInput = inputValues[valueIndex]!;
    let stateStart = valueIndex * sectionCount * 2;
    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
      const coefficients = sections[sectionIndex]!;
      const sectionOutput = coefficients.b0 * sectionInput + delayState[stateStart]!;
      delayState[stateStart] =
        coefficients.b1 * sectionInput - coefficients.a1 * sectionOutput + delayState[stateStart + 1]!;
      delayState[stateStart + 1] = coefficients.b2 * sectionInput - coefficients.a2 * sectionOutput;
      sectionInput = sectionOutput;
      stateStart += 2;
    }
    outputValues[valueIndex] = sectionInput;
  }
}

/** Olvida la historia: el siguiente fotograma vuelve a inicializar el filtro. */
export function resetPixelBandpassFilter(filter: PixelBandpassFilter): void {
  filter.delayState.fill(0);
  filter.isPrimed = false;
}
