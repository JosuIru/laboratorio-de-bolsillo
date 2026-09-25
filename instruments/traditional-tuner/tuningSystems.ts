import type { NoteIndex } from '@/processing/dsp/musicalNotes';

/**
 * Un sistema de afinación se guarda como la desviación, en centésimas, de cada grado de la
 * escala (0 = tónica … 11) respecto al temperamento igual. La tónica se queda donde la pone el
 * temperamento igual con el La de referencia elegido.
 */
export type CentsByDegree = readonly number[];

export type BuiltInTuningSystemId = 'equal' | 'just' | 'pythagorean' | 'quarter-comma-meantone';

export const degreeCount = 12;

function centsOfRatio(frequencyRatio: number): number {
  return 1200 * Math.log2(frequencyRatio);
}

/** Pasa razones de frecuencia (una por grado, desde la tónica) a desviaciones del temperamento igual. */
function ratiosToCentsByDegree(frequencyRatios: readonly number[]): number[] {
  return frequencyRatios.map((frequencyRatio, degree) => centsOfRatio(frequencyRatio) - 100 * degree);
}

/** Entonación justa de 5 límites: terceras y quintas puras respecto a la tónica (empastan con un bordón). */
const justIntonationRatios = [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];

/** Pitagórica: todo por quintas puras (3/2). */
const pythagoreanRatios = [
  1,
  256 / 243,
  9 / 8,
  32 / 27,
  81 / 64,
  4 / 3,
  729 / 512,
  3 / 2,
  128 / 81,
  27 / 16,
  16 / 9,
  243 / 128,
];

/**
 * Mesotónica de 1/4 de coma: quintas estrechadas 1/4 de coma sintónica para que las terceras
 * mayores salgan puras. Cadena de quintas de la tónica −3 a +8 (en Do: Mi♭ … Sol♯).
 */
function quarterCommaMeantoneCentsByDegree(): number[] {
  const syntonicCommaCents = centsOfRatio(81 / 80);
  const temperedFifthCents = centsOfRatio(3 / 2) - syntonicCommaCents / 4;
  const centsByDegree = new Array<number>(degreeCount).fill(0);
  for (let fifthsFromTonic = -3; fifthsFromTonic <= 8; fifthsFromTonic++) {
    const degree = (((7 * fifthsFromTonic) % degreeCount) + degreeCount) % degreeCount;
    const pitchCents = (((fifthsFromTonic * temperedFifthCents) % 1200) + 1200) % 1200;
    centsByDegree[degree] = pitchCents - 100 * degree;
  }
  return centsByDegree;
}

export const builtInTuningSystems: Record<BuiltInTuningSystemId, CentsByDegree> = {
  equal: new Array<number>(degreeCount).fill(0),
  just: ratiosToCentsByDegree(justIntonationRatios),
  pythagorean: ratiosToCentsByDegree(pythagoreanRatios),
  'quarter-comma-meantone': quarterCommaMeantoneCentsByDegree(),
};

export const builtInTuningSystemIds = Object.keys(builtInTuningSystems) as BuiltInTuningSystemId[];

export interface TuningContext {
  referenceA4Hz: number;
  tonicNoteIndex: NoteIndex;
  centsByDegree: CentsByDegree;
}

export interface TuningTarget {
  noteIndex: NoteIndex;
  /** Octava científica: La4 = 440 Hz. */
  octave: number;
  /** Grado de la escala respecto a la tónica (0…11). */
  degree: number;
  targetFrequencyHz: number;
  /** Cuánto se aleja lo medido de la nota objetivo, en centésimas (positivo = alto). */
  centsOffset: number;
}

/** Nota objetivo más cercana según el sistema de afinación, y la desviación respecto a ella. */
export function findTuningTarget(frequencyHz: number, tuningContext: TuningContext): TuningTarget | null {
  if (!(frequencyHz > 0) || !Number.isFinite(frequencyHz)) return null;
  const { referenceA4Hz, tonicNoteIndex, centsByDegree } = tuningContext;
  const measuredCentsFromA4 = centsOfRatio(frequencyHz / referenceA4Hz);
  const nearestEqualSemitone = Math.round(measuredCentsFromA4 / 100);

  let bestTarget: TuningTarget | null = null;
  // Las desviaciones pueden pasar de medio semitono: se miran también los vecinos.
  for (let semitoneFromA4 = nearestEqualSemitone - 1; semitoneFromA4 <= nearestEqualSemitone + 1; semitoneFromA4++) {
    // MIDI: La4 = 69; Do4 = 60.
    const midiNumber = 69 + semitoneFromA4;
    const noteIndex = (((midiNumber % 12) + 12) % 12) as NoteIndex;
    const degree = (noteIndex - tonicNoteIndex + degreeCount) % degreeCount;
    const targetCentsFromA4 = 100 * semitoneFromA4 + (centsByDegree[degree] ?? 0);
    const centsOffset = measuredCentsFromA4 - targetCentsFromA4;
    if (!bestTarget || Math.abs(centsOffset) < Math.abs(bestTarget.centsOffset)) {
      bestTarget = {
        noteIndex,
        octave: Math.floor(midiNumber / 12) - 1,
        degree,
        targetFrequencyHz: referenceA4Hz * 2 ** (targetCentsFromA4 / 1200),
        centsOffset,
      };
    }
  }
  return bestTarget;
}

/**
 * Desviación respecto al temperamento igual del grado que suena, para guardarla en una tabla
 * propia («esta nota de mi alboka está 14 centésimas alta»).
 */
export function measureDegreeDeviation(
  frequencyHz: number,
  referenceA4Hz: number,
  tonicNoteIndex: NoteIndex,
): { degree: number; centsFromEqual: number } | null {
  const equalTarget = findTuningTarget(frequencyHz, {
    referenceA4Hz,
    tonicNoteIndex,
    centsByDegree: builtInTuningSystems.equal,
  });
  return equalTarget ? { degree: equalTarget.degree, centsFromEqual: equalTarget.centsOffset } : null;
}

// ── Lectura estable ─────────────────────────────────────────────────────────────────────────

/** Claridad mínima de la NSDF para fiarse de una estimación. */
export const minimumPitchClarity = 0.85;
/** Si la nota salta más de esto respecto a la mediana, se empieza de cero (nota nueva). */
const noteChangeCents = 50;

/**
 * Mediana de las últimas estimaciones válidas: quita los saltos sueltos sin arrastrar la nota
 * anterior cuando el músico cambia de nota.
 */
export function createPitchStabilizer(windowSize = 5) {
  const recentFrequenciesHz: number[] = [];

  function medianFrequencyHz(): number | null {
    if (recentFrequenciesHz.length === 0) return null;
    const sortedFrequenciesHz = [...recentFrequenciesHz].sort((leftHz, rightHz) => leftHz - rightHz);
    const middleIndex = sortedFrequenciesHz.length >> 1;
    return sortedFrequenciesHz.length % 2 === 1
      ? sortedFrequenciesHz[middleIndex]!
      : Math.sqrt(sortedFrequenciesHz[middleIndex - 1]! * sortedFrequenciesHz[middleIndex]!);
  }

  return {
    /** `null` = en esta trama no había un tono claro. Devuelve la frecuencia estable o null. */
    push(frequencyHz: number | null): number | null {
      if (frequencyHz === null) {
        // En silencio se va vaciando para que la lectura desaparezca al dejar de tocar.
        recentFrequenciesHz.shift();
        return medianFrequencyHz();
      }
      const currentMedianHz = medianFrequencyHz();
      if (currentMedianHz !== null && Math.abs(centsOfRatio(frequencyHz / currentMedianHz)) > noteChangeCents) {
        recentFrequenciesHz.length = 0;
      }
      recentFrequenciesHz.push(frequencyHz);
      if (recentFrequenciesHz.length > windowSize) recentFrequenciesHz.shift();
      return medianFrequencyHz();
    },
    reset(): void {
      recentFrequenciesHz.length = 0;
    },
  };
}

// ── La de referencia ────────────────────────────────────────────────────────────────────────

export const minimumReferenceA4Hz = 400;
export const maximumReferenceA4Hz = 480;
export const defaultReferenceA4Hz = 440;

export function clampReferenceA4Hz(referenceA4Hz: number): number {
  return Math.min(maximumReferenceA4Hz, Math.max(minimumReferenceA4Hz, referenceA4Hz));
}
