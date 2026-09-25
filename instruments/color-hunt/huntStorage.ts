import Storage from 'expo-sqlite/kv-store';

import { parsePersonalRecord, type PersonalRecord } from './colorHuntGame';

const personalRecordStorageKey = 'colorHunt.personalRecord';

export function loadPersonalRecord(): PersonalRecord | null {
  try {
    return parsePersonalRecord(Storage.getItemSync(personalRecordStorageKey));
  } catch {
    return null;
  }
}

/** Guarda una nueva mejor puntuación con la fecha de ahora y devuelve el récord guardado. */
export function savePersonalRecord(bestTotalPoints: number): PersonalRecord {
  const personalRecord: PersonalRecord = { bestTotalPoints, achievedAt: Date.now() };
  try {
    Storage.setItemSync(personalRecordStorageKey, JSON.stringify(personalRecord));
  } catch {
    // Si no se puede guardar, el récord vale al menos para esta sesión.
  }
  return personalRecord;
}
