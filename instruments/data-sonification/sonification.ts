/**
 * Sonificación: convierte el valor de un sensor en sonido. En modo melodía el valor elige una
 * nota de una escala (así suena a música y se oyen los cambios como intervalos); en modo theremin,
 * un tono continuo sube y baja con el valor.
 */

export type SonificationSourceId = 'tilt' | 'vibration' | 'rotation' | 'magnetic' | 'light';
export type SonificationMode = 'melody' | 'theremin';
export type SonificationScaleId = 'major-pentatonic' | 'minor-pentatonic' | 'major' | 'chromatic';

interface SourceRange {
  minimumValue: number;
  maximumValue: number;
  /** Escala logarítmica: para magnitudes que abarcan varios órdenes (vibración, luz). */
  isLogarithmic: boolean;
  unit: string;
}

/** Rango de cada fuente que se reparte entre la nota más grave y la más aguda. */
export const sourceRanges: Record<SonificationSourceId, SourceRange> = {
  /** Inclinación del móvil respecto a la horizontal, en grados. */
  tilt: { minimumValue: 0, maximumValue: 90, isLogarithmic: false, unit: '°' },
  /** Aceleración sin la gravedad, en m/s². */
  vibration: { minimumValue: 0.02, maximumValue: 20, isLogarithmic: true, unit: 'm/s²' },
  /** Velocidad de giro, en rad/s. */
  rotation: { minimumValue: 0, maximumValue: 8, isLogarithmic: false, unit: 'rad/s' },
  /** Diferencia del campo magnético respecto al del arranque, en µT. */
  magnetic: { minimumValue: 0, maximumValue: 200, isLogarithmic: false, unit: 'µT' },
  /** Iluminancia, en lux. */
  light: { minimumValue: 1, maximumValue: 30000, isLogarithmic: true, unit: 'lx' },
};

/** Valor de la fuente llevado a [0, 1] según su rango (fuera de rango se satura). */
export function normalizeSourceValue(sourceId: SonificationSourceId, sourceValue: number): number {
  const { minimumValue, maximumValue, isLogarithmic } = sourceRanges[sourceId];
  if (!Number.isFinite(sourceValue)) return 0;
  const normalizedValue = isLogarithmic
    ? Math.log(Math.max(minimumValue, sourceValue) / minimumValue) / Math.log(maximumValue / minimumValue)
    : (sourceValue - minimumValue) / (maximumValue - minimumValue);
  return Math.min(1, Math.max(0, normalizedValue));
}

/** Semitonos de cada escala dentro de una octava. */
export const scaleSemitones: Record<SonificationScaleId, readonly number[]> = {
  'major-pentatonic': [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** Nota más grave de la melodía (Do3, MIDI 48) y octavas que abarca. */
const lowestMidiNote = 48;
const melodyOctaveCount = 3;

/** Notas MIDI disponibles en la escala, de grave a agudo (incluye la tónica final). */
export function melodyNotes(scaleId: SonificationScaleId): number[] {
  const semitones = scaleSemitones[scaleId];
  const midiNotes: number[] = [];
  for (let octaveIndex = 0; octaveIndex < melodyOctaveCount; octaveIndex++) {
    for (const semitone of semitones) midiNotes.push(lowestMidiNote + 12 * octaveIndex + semitone);
  }
  midiNotes.push(lowestMidiNote + 12 * melodyOctaveCount);
  return midiNotes;
}

/** Nota de la escala que corresponde a un valor normalizado. */
export function normalizedValueToMidiNote(normalizedValue: number, scaleId: SonificationScaleId): number {
  const availableNotes = melodyNotes(scaleId);
  const noteIndex = Math.min(availableNotes.length - 1, Math.floor(normalizedValue * availableNotes.length));
  return availableNotes[Math.max(0, noteIndex)]!;
}

export function midiNoteToFrequencyHz(midiNote: number): number {
  return 440 * 2 ** ((midiNote - 69) / 12);
}

/** Theremin: de 130 Hz a 1050 Hz (tres octavas) en escala logarítmica, que es como se oye la altura. */
const thereminLowestHz = 130.8;
const thereminOctaveCount = 3;

export function normalizedValueToThereminFrequencyHz(normalizedValue: number): number {
  return thereminLowestHz * 2 ** (thereminOctaveCount * Math.min(1, Math.max(0, normalizedValue)));
}

/** Inclinación respecto a la horizontal a partir de la gravedad medida: 0° tumbado, 90° de pie. */
export function tiltDegreesFromGravity(accelerationX: number, accelerationY: number, accelerationZ: number): number {
  const horizontalComponent = Math.hypot(accelerationX, accelerationY);
  return (Math.atan2(horizontalComponent, Math.abs(accelerationZ)) * 180) / Math.PI;
}

/**
 * Suavizado exponencial con constante de tiempo: evita que el ruido del sensor haga saltar la
 * nota de un lado a otro en cada muestra.
 */
export function createValueSmoother(timeConstantSeconds: number) {
  let smoothedValue: number | null = null;
  let lastTimestampSeconds: number | null = null;
  return {
    push(sampleValue: number, timestampSeconds: number): number {
      if (smoothedValue === null || lastTimestampSeconds === null) {
        smoothedValue = sampleValue;
      } else {
        const elapsedSeconds = Math.max(0, timestampSeconds - lastTimestampSeconds);
        const blendFactor = 1 - Math.exp(-elapsedSeconds / timeConstantSeconds);
        smoothedValue += blendFactor * (sampleValue - smoothedValue);
      }
      lastTimestampSeconds = timestampSeconds;
      return smoothedValue;
    },
    reset(): void {
      smoothedValue = null;
      lastTimestampSeconds = null;
    },
  };
}
