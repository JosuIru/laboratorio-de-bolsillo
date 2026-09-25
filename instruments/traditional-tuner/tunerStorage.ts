import Storage from 'expo-sqlite/kv-store';

import type { NoteIndex } from '@/processing/dsp/musicalNotes';

import {
  type BuiltInTuningSystemId,
  builtInTuningSystemIds,
  clampReferenceA4Hz,
  defaultReferenceA4Hz,
  degreeCount,
} from './tuningSystems';

/** Tabla de afinación de un instrumento concreto (una alboka, un txistu…), hecha por el usuario. */
export interface CustomTuning {
  id: string;
  name: string;
  /** Desviación de cada grado (0 = tónica) respecto al temperamento igual, en centésimas. */
  centsByDegree: number[];
}

export interface TunerSettings {
  referenceA4Hz: number;
  tonicNoteIndex: NoteIndex;
  /** Un sistema incorporado o el id de una tabla propia. */
  selectedTuningId: BuiltInTuningSystemId | string;
  customTunings: CustomTuning[];
}

const settingsStorageKey = 'traditional-tuner.settings';
/** Una tabla propia no debería desviar un grado más de un semitono. */
const maximumCustomDeviationCents = 100;

export const defaultTunerSettings: TunerSettings = {
  referenceA4Hz: defaultReferenceA4Hz,
  tonicNoteIndex: 0,
  selectedTuningId: 'equal',
  customTunings: [],
};

function parseCustomTuning(candidateTuning: unknown): CustomTuning[] {
  if (typeof candidateTuning !== 'object' || candidateTuning === null) return [];
  const { id, name, centsByDegree } = candidateTuning as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(centsByDegree)) return [];
  if (centsByDegree.length !== degreeCount) return [];
  const isEveryDeviationValid = centsByDegree.every(
    (degreeCents) =>
      typeof degreeCents === 'number' &&
      Number.isFinite(degreeCents) &&
      Math.abs(degreeCents) <= maximumCustomDeviationCents,
  );
  return isEveryDeviationValid ? [{ id, name, centsByDegree: centsByDegree as number[] }] : [];
}

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredTunerSettings(storedText: string | null): TunerSettings {
  if (!storedText) return defaultTunerSettings;
  try {
    const parsedValue = JSON.parse(storedText) as Record<string, unknown>;
    const customTunings = Array.isArray(parsedValue.customTunings)
      ? parsedValue.customTunings.flatMap(parseCustomTuning)
      : [];
    const referenceA4Hz =
      typeof parsedValue.referenceA4Hz === 'number' && Number.isFinite(parsedValue.referenceA4Hz)
        ? clampReferenceA4Hz(parsedValue.referenceA4Hz)
        : defaultReferenceA4Hz;
    const tonicNoteIndex =
      typeof parsedValue.tonicNoteIndex === 'number' &&
      Number.isInteger(parsedValue.tonicNoteIndex) &&
      parsedValue.tonicNoteIndex >= 0 &&
      parsedValue.tonicNoteIndex < degreeCount
        ? (parsedValue.tonicNoteIndex as NoteIndex)
        : 0;
    const selectedTuningId = parsedValue.selectedTuningId;
    const isSelectionKnown =
      typeof selectedTuningId === 'string' &&
      ((builtInTuningSystemIds as string[]).includes(selectedTuningId) ||
        customTunings.some((customTuning) => customTuning.id === selectedTuningId));
    return {
      referenceA4Hz,
      tonicNoteIndex,
      selectedTuningId: isSelectionKnown ? selectedTuningId : 'equal',
      customTunings,
    };
  } catch {
    return defaultTunerSettings;
  }
}

export function loadTunerSettings(): TunerSettings {
  try {
    return parseStoredTunerSettings(Storage.getItemSync(settingsStorageKey));
  } catch {
    return defaultTunerSettings;
  }
}

export function saveTunerSettings(tunerSettings: TunerSettings): void {
  try {
    Storage.setItemSync(settingsStorageKey, JSON.stringify(tunerSettings));
  } catch {
    // Si no se puede guardar, el afinador sigue funcionando con los ajustes en memoria.
  }
}

/** Guarda en la tabla la desviación medida de un grado, redondeada a la centésima. */
export function setCustomTuningDegree(customTuning: CustomTuning, degree: number, centsFromEqual: number): CustomTuning {
  const clampedCents = Math.max(-maximumCustomDeviationCents, Math.min(maximumCustomDeviationCents, centsFromEqual));
  return {
    ...customTuning,
    centsByDegree: customTuning.centsByDegree.map((degreeCents, candidateDegree) =>
      candidateDegree === degree ? Math.round(clampedCents) : degreeCents,
    ),
  };
}
