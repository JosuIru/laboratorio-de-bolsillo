/**
 * Llegada del chirrido de referencia a un micrófono, con precisión de fracción de muestra.
 *
 * Se correlaciona la grabación con el chirrido (filtro adaptado del sonar, que da directamente la
 * envolvente de la correlación). Un chirrido comprimido deja un pico estrecho (~1/ancho de banda,
 * unos 0,17 ms); un golpe seco, en cambio, deja una meseta tan larga como el propio chirrido. Por
 * eso el criterio de detección no es la altura del pico, sino cuánto sobresale respecto a lo que
 * hay justo antes de él («nitidez»): así una palmada o un portazo no se confunden con el chirrido.
 *
 * En una sala el sonido llega también rebotado. El rebote puede ser más fuerte que el camino
 * directo, pero nunca llega antes: se toma el primer pico que alcance la mitad del máximo.
 */

import { interpolatePeak } from '@/processing/sonar/echoProfile';
import {
  computeCorrelationEnvelope,
  createMatchedFilter,
  type MatchedFilter,
  nextPowerOfTwo,
} from '@/processing/sonar/matchedFilter';

import { referenceChirpSpecification } from './referenceSignal';

export interface ChirpArrival {
  /** Índice (fraccionario) de la muestra donde empieza el chirrido en el array analizado. */
  arrivalSampleIndex: number;
  /** Amplitud de la copia recibida (1 = el chirrido tal cual se generó). */
  amplitude: number;
  /** Pico dividido por la media de la envolvente en los milisegundos anteriores. */
  sharpness: number;
}

export interface ChirpLocatorOptions {
  sampleRateHz: number;
  chirpSamples: Float32Array;
  /** Longitud máxima de los tramos que se analizarán (en muestras). */
  maximumSegmentLength: number;
}

/** Ventana previa al pico con la que se mide la nitidez. */
const sharpnessWindowStartSeconds = 0.02;
const sharpnessWindowEndSeconds = 0.002;
/** Hasta dónde antes del máximo se busca un camino directo más débil. */
const directPathLookbackSeconds = 0.012;
const directPathRelativeThreshold = 0.5;
export const defaultMinimumSharpness = 8;
/** Por debajo de esto la envolvente es ruido numérico (silencio digital). */
const minimumDetectableAmplitude = 1e-4;

export interface ChirpLocator {
  matchedFilter: MatchedFilter;
  envelope: Float64Array;
  sampleRateHz: number;
  chirpLength: number;
  /** Muestras al principio del tramo que se reservan para medir la nitidez. */
  guardSamples: number;
}

export function createChirpLocator(options: ChirpLocatorOptions): ChirpLocator {
  const { sampleRateHz, chirpSamples, maximumSegmentLength } = options;
  const fftSize = nextPowerOfTwo(Math.max(maximumSegmentLength, chirpSamples.length * 2));
  const matchedFilter = createMatchedFilter({
    chirpSamples,
    fftSize,
    sampleRateHz,
    passbandLowHz: Math.min(referenceChirpSpecification.startFrequencyHz, referenceChirpSpecification.endFrequencyHz),
    passbandHighHz: Math.max(referenceChirpSpecification.startFrequencyHz, referenceChirpSpecification.endFrequencyHz),
  });
  return {
    matchedFilter,
    envelope: new Float64Array(fftSize),
    sampleRateHz,
    chirpLength: chirpSamples.length,
    guardSamples: Math.ceil(sharpnessWindowStartSeconds * sampleRateHz),
  };
}

/**
 * Busca el chirrido que empieza entre `searchStartIndex` y `searchEndIndex` (excluido) de
 * `samples`. Hace falta grabación desde `guardSamples` antes del inicio de la búsqueda y hasta un
 * chirrido después del final. Devuelve `null` si no hay ninguno suficientemente nítido.
 */
export function locateChirp(
  chirpLocator: ChirpLocator,
  samples: ArrayLike<number>,
  searchStartIndex: number,
  searchEndIndex: number,
  minimumSharpness = defaultMinimumSharpness,
): ChirpArrival | null {
  const { matchedFilter, envelope, sampleRateHz, chirpLength, guardSamples } = chirpLocator;
  const segmentStartIndex = Math.max(0, searchStartIndex - guardSamples);
  const segmentEndIndex = Math.min(samples.length, searchEndIndex + chirpLength, segmentStartIndex + matchedFilter.fftSize);
  const segmentLength = segmentEndIndex - segmentStartIndex;
  if (segmentLength < chirpLength) return null;
  const segment = new Float64Array(segmentLength);
  for (let offset = 0; offset < segmentLength; offset++) segment[offset] = samples[segmentStartIndex + offset]!;
  const validLagCount = computeCorrelationEnvelope(matchedFilter, segment, envelope);

  const firstLag = searchStartIndex - segmentStartIndex;
  const endLag = Math.min(validLagCount, searchEndIndex - segmentStartIndex);
  if (endLag <= firstLag) return null;

  let maximumLag = firstLag;
  for (let lagIndex = firstLag + 1; lagIndex < endLag; lagIndex++) {
    if (envelope[lagIndex]! > envelope[maximumLag]!) maximumLag = lagIndex;
  }
  const maximumValue = envelope[maximumLag]!;
  if (!(maximumValue > minimumDetectableAmplitude)) return null;

  // Camino directo: el primer máximo local que llegue a la mitad del más alto.
  const lookbackStartLag = Math.max(1, maximumLag - Math.round(directPathLookbackSeconds * sampleRateHz));
  let directLag = maximumLag;
  for (let lagIndex = lookbackStartLag; lagIndex < maximumLag; lagIndex++) {
    const lagValue = envelope[lagIndex]!;
    if (
      lagValue >= directPathRelativeThreshold * maximumValue &&
      lagValue >= envelope[lagIndex - 1]! &&
      lagValue >= envelope[lagIndex + 1]!
    ) {
      directLag = lagIndex;
      break;
    }
  }

  const sharpnessStartLag = Math.max(0, directLag - Math.round(sharpnessWindowStartSeconds * sampleRateHz));
  const sharpnessEndLag = Math.max(sharpnessStartLag + 1, directLag - Math.round(sharpnessWindowEndSeconds * sampleRateHz));
  let precedingSum = 0;
  for (let lagIndex = sharpnessStartLag; lagIndex < sharpnessEndLag; lagIndex++) precedingSum += envelope[lagIndex]!;
  const precedingMean = Math.max(precedingSum / (sharpnessEndLag - sharpnessStartLag), 1e-12);

  const { position, amplitude } = interpolatePeak(envelope, directLag);
  const sharpness = amplitude / precedingMean;
  if (sharpness < minimumSharpness) return null;
  return { arrivalSampleIndex: segmentStartIndex + position, amplitude, sharpness };
}
