/** Índice 0-11 de la nota (0 = Do/C) para traducir su nombre en la interfaz. */
export type NoteIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export interface MusicalNote {
  noteIndex: NoteIndex;
  /** Octava científica: La4 = 440 Hz. */
  octave: number;
  /** Desviación respecto a la nota afinada, en centésimas de semitono (−50…+50). */
  centsOffset: number;
  exactFrequencyHz: number;
}

/** Nota temperada más cercana, con referencia La4 (A4) configurable. */
export function frequencyToMusicalNote(frequencyHz: number, referenceA4Hz = 440): MusicalNote | null {
  if (!(frequencyHz > 0) || !Number.isFinite(frequencyHz)) return null;
  const semitonesFromA4 = 12 * Math.log2(frequencyHz / referenceA4Hz);
  const nearestSemitone = Math.round(semitonesFromA4);
  // MIDI: La4 = 69; Do4 = 60.
  const midiNumber = 69 + nearestSemitone;
  return {
    noteIndex: (((midiNumber % 12) + 12) % 12) as NoteIndex,
    octave: Math.floor(midiNumber / 12) - 1,
    // `|| 0` evita mostrar «−0» cuando la nota está afinada.
    centsOffset: Math.round((semitonesFromA4 - nearestSemitone) * 100) || 0,
    exactFrequencyHz: referenceA4Hz * 2 ** (nearestSemitone / 12),
  };
}
