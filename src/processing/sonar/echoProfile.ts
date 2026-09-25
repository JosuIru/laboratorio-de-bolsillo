import type { ColumnBinMapping } from '@/processing/dsp/spectrogram';

import { distanceToEchoDelaySeconds, echoDelayToDistanceMeters } from './soundSpeed';

/**
 * Perfil de ecos: la envolvente del filtro adaptado a partir del acoplamiento directo
 * altavoz → micrófono, normalizada por la amplitud de ese acoplamiento. El índice 0 es el
 * «tiempo cero» y el índice `i` corresponde a un retardo de `i / fs` segundos. Normalizar por
 * el acoplamiento directo hace que el perfil no dependa del volumen.
 */

/** Pico con interpolación parabólica: posición fraccionaria y altura. */
export interface InterpolatedPeak {
  position: number;
  amplitude: number;
}

export function interpolatePeak(values: ArrayLike<number>, peakIndex: number): InterpolatedPeak {
  'worklet';
  const peakValue = values[peakIndex]!;
  if (peakIndex <= 0 || peakIndex >= values.length - 1) return { position: peakIndex, amplitude: peakValue };
  const leftValue = values[peakIndex - 1]!;
  const rightValue = values[peakIndex + 1]!;
  const curvature = leftValue - 2 * peakValue + rightValue;
  if (!(curvature < 0)) return { position: peakIndex, amplitude: peakValue };
  const offset = (0.5 * (leftValue - rightValue)) / curvature;
  return { position: peakIndex + offset, amplitude: peakValue - 0.25 * (leftValue - rightValue) * offset };
}

export function indexOfMaximum(values: ArrayLike<number>, firstIndex: number, endIndex: number): number {
  'worklet';
  let maximumIndex = firstIndex;
  for (let valueIndex = firstIndex + 1; valueIndex < endIndex; valueIndex++) {
    if (values[valueIndex]! > values[maximumIndex]!) maximumIndex = valueIndex;
  }
  return maximumIndex;
}

/** Mediana de un tramo (copia y ordena: solo para tramos de unos pocos miles de valores). */
export function medianOf(values: ArrayLike<number>, firstIndex = 0, endIndex = values.length): number {
  const sortedValues = Array.from(
    { length: Math.max(0, endIndex - firstIndex) },
    (_, offset) => values[firstIndex + offset]!,
  ).sort((leftValue, rightValue) => leftValue - rightValue);
  if (sortedValues.length === 0) return 0;
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1
    ? sortedValues[middleIndex]!
    : (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
}

/**
 * Media móvil de los últimos `pulseCount` perfiles: los ecos (fijos respecto al tiempo cero) se
 * suman y el ruido, que no lo está, se promedia hacia abajo.
 */
export function createProfileAverager(profileLength: number, pulseCount: number) {
  const storedProfiles = Array.from({ length: pulseCount }, () => new Float64Array(profileLength));
  const runningSum = new Float64Array(profileLength);
  const averagedProfile = new Float64Array(profileLength);
  let nextSlotIndex = 0;
  let storedCount = 0;
  return {
    /** Añade un perfil y devuelve la media (array reutilizado). */
    push(profile: ArrayLike<number>): Float64Array {
      const slotProfile = storedProfiles[nextSlotIndex]!;
      for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
        const newValue = profile[sampleIndex] ?? 0;
        runningSum[sampleIndex] = runningSum[sampleIndex]! - slotProfile[sampleIndex]! + newValue;
        slotProfile[sampleIndex] = newValue;
      }
      nextSlotIndex = (nextSlotIndex + 1) % pulseCount;
      storedCount = Math.min(pulseCount, storedCount + 1);
      for (let sampleIndex = 0; sampleIndex < profileLength; sampleIndex++) {
        averagedProfile[sampleIndex] = Math.max(0, runningSum[sampleIndex]! / storedCount);
      }
      return averagedProfile;
    },
    get averagedPulseCount(): number {
      return storedCount;
    },
    reset(): void {
      storedProfiles.forEach((storedProfile) => storedProfile.fill(0));
      runningSum.fill(0);
      nextSlotIndex = 0;
      storedCount = 0;
    },
  };
}

/**
 * Resta el fondo estático (perfil grabado sin nada delante: la mesa, las paredes, la cola del
 * acoplamiento directo). Lo que queda son los objetos nuevos o que se mueven. No baja de 0.
 */
export function subtractBackgroundProfile(
  profile: ArrayLike<number>,
  backgroundProfile: ArrayLike<number>,
  output: Float64Array,
): Float64Array {
  'worklet';
  for (let sampleIndex = 0; sampleIndex < output.length; sampleIndex++) {
    output[sampleIndex] = Math.max(0, (profile[sampleIndex] ?? 0) - (backgroundProfile[sampleIndex] ?? 0));
  }
  return output;
}

export interface StrongestEcho {
  /** Retardo respecto al acoplamiento directo (con precisión de fracción de muestra). */
  echoDelaySeconds: number;
  distanceMeters: number;
  /** Altura del eco respecto al acoplamiento directo (1 = igual de fuerte). */
  relativeAmplitude: number;
  /** Cuánto sobresale el eco de la mediana del perfil, en unidades de dispersión del ruido. */
  signalToNoiseRatio: number;
}

export interface StrongestEchoOptions {
  sampleRateHz: number;
  temperatureCelsius: number;
  minimumDistanceMeters: number;
  maximumDistanceMeters: number;
  /** El eco debe superar la mediana en este número de dispersiones del ruido. */
  minimumSignalToNoiseRatio?: number;
  /** Altura mínima relativa al acoplamiento directo (−54 dB por defecto). */
  minimumRelativeAmplitude?: number;
  /** Posición fraccionaria del acoplamiento directo respecto al índice 0 del perfil. */
  directPeakFractionalOffset?: number;
}

/**
 * El eco más fuerte dentro del rango de distancias, o null si no destaca del ruido.
 *
 * - Se salta la ladera de bajada de la cola del acoplamiento directo: si el perfil aún baja al
 *   principio del rango, eso no es un eco sino el final del pulso directo.
 * - El umbral es la mediana más varias veces la dispersión (MAD). Así, al promediar pulsos, el
 *   ruido fluctúa menos, el umbral baja y aparecen ecos más débiles.
 */
export function findStrongestEcho(profile: ArrayLike<number>, options: StrongestEchoOptions): StrongestEcho | null {
  const {
    sampleRateHz,
    temperatureCelsius,
    minimumDistanceMeters,
    maximumDistanceMeters,
    minimumSignalToNoiseRatio = 6,
    minimumRelativeAmplitude = 0.002,
    directPeakFractionalOffset = 0,
  } = options;
  const rangeStartIndex = Math.max(
    1,
    Math.ceil(distanceToEchoDelaySeconds(minimumDistanceMeters, temperatureCelsius) * sampleRateHz),
  );
  const endIndex = Math.min(
    profile.length - 1,
    Math.floor(distanceToEchoDelaySeconds(maximumDistanceMeters, temperatureCelsius) * sampleRateHz) + 1,
  );
  if (endIndex <= rangeStartIndex + 2) return null;
  let searchStartIndex = rangeStartIndex;
  while (searchStartIndex + 1 < endIndex && profile[searchStartIndex + 1]! <= profile[searchStartIndex]!)
    searchStartIndex++;
  if (searchStartIndex + 1 >= endIndex) return null;

  const noiseMedian = medianOf(profile, rangeStartIndex, endIndex);
  const absoluteDeviations = Array.from({ length: endIndex - rangeStartIndex }, (_, offset) =>
    Math.abs(profile[rangeStartIndex + offset]! - noiseMedian),
  );
  const noiseSpread = Math.max(1.4826 * medianOf(absoluteDeviations), 1e-9);

  const peakIndex = indexOfMaximum(profile, searchStartIndex, endIndex);
  const { position, amplitude } = interpolatePeak(profile, peakIndex);
  const signalToNoiseRatio = (amplitude - noiseMedian) / noiseSpread;
  if (!(amplitude > minimumRelativeAmplitude) || signalToNoiseRatio < minimumSignalToNoiseRatio) return null;
  const echoDelaySeconds = (position - directPeakFractionalOffset) / sampleRateHz;
  return {
    echoDelaySeconds,
    distanceMeters: echoDelayToDistanceMeters(echoDelaySeconds, temperatureCelsius),
    relativeAmplitude: amplitude,
    signalToNoiseRatio,
  };
}

/**
 * Reparto de las muestras del perfil entre las columnas del ecograma (0 m a la izquierda,
 * `maximumDistanceMeters` a la derecha). Tiene la misma forma que el reparto de bins del
 * espectrograma, así que se pinta con `pushSpectrumRow` y `SpectrogramView`.
 */
export function createDistanceColumnMapping(
  columnCount: number,
  profileLength: number,
  sampleRateHz: number,
  temperatureCelsius: number,
  maximumDistanceMeters: number,
): ColumnBinMapping {
  const firstBinByColumn = new Uint32Array(columnCount);
  const lastBinByColumn = new Uint32Array(columnCount);
  const lastValidIndex = profileLength - 1;
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
    const startDistanceMeters = (columnIndex / columnCount) * maximumDistanceMeters;
    const endDistanceMeters = ((columnIndex + 1) / columnCount) * maximumDistanceMeters;
    const firstIndex = Math.min(
      lastValidIndex,
      Math.round(distanceToEchoDelaySeconds(startDistanceMeters, temperatureCelsius) * sampleRateHz),
    );
    const lastIndex = Math.min(
      lastValidIndex,
      Math.max(
        firstIndex,
        Math.round(distanceToEchoDelaySeconds(endDistanceMeters, temperatureCelsius) * sampleRateHz) - 1,
      ),
    );
    firstBinByColumn[columnIndex] = firstIndex;
    lastBinByColumn[columnIndex] = lastIndex;
  }
  return {
    firstBinByColumn,
    lastBinByColumn,
    minimumFrequencyHz: 0,
    maximumFrequencyHz: maximumDistanceMeters,
    scale: 'linear',
  };
}

/** Perfil (amplitud relativa al acoplamiento directo) en dB, para el ecograma. */
export function profileToDecibels(profile: ArrayLike<number>, output: Float64Array, floorDecibels = -80): Float64Array {
  'worklet';
  for (let sampleIndex = 0; sampleIndex < output.length; sampleIndex++) {
    const amplitude = profile[sampleIndex] ?? 0;
    output[sampleIndex] = amplitude > 0 ? Math.max(floorDecibels, 20 * Math.log10(amplitude)) : floorDecibels;
  }
  return output;
}
