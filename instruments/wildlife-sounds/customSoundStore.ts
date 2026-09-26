import type { CustomSoundClass, CustomSoundExample } from './customSounds';
import { getDetectionDatabase } from './detectionStore';

/**
 * Clases propias en la base de datos del instrumento: una fila por clase y una por ejemplo (con
 * el embedding en float16; nunca audio).
 */

interface CustomClassRow {
  id: number;
  name: string;
  is_background: number;
  created_at: string;
}

interface CustomExampleRow {
  id: number;
  class_id: number;
  recorded_at: string;
  model_version: string;
  embedding: Uint8Array;
}

export interface CustomSoundLibrary {
  customClasses: CustomSoundClass[];
  examples: CustomSoundExample[];
}

/** Todas las clases (por orden de creación) con todos sus ejemplos. Son pocos: caben en memoria. */
export async function readCustomSoundLibrary(): Promise<CustomSoundLibrary> {
  const database = await getDetectionDatabase();
  const [classRows, exampleRows] = await Promise.all([
    database.getAllAsync<CustomClassRow>('SELECT * FROM custom_sound_classes ORDER BY id'),
    database.getAllAsync<CustomExampleRow>('SELECT * FROM custom_sound_examples ORDER BY class_id, id'),
  ]);
  return {
    customClasses: classRows.map((classRow) => ({
      id: classRow.id,
      name: classRow.name,
      isBackground: classRow.is_background === 1,
      createdAtIso: classRow.created_at,
    })),
    examples: exampleRows.map((exampleRow) => ({
      id: exampleRow.id,
      classId: exampleRow.class_id,
      recordedAtIso: exampleRow.recorded_at,
      modelVersion: exampleRow.model_version,
      embeddingFloat16Bytes: exampleRow.embedding,
    })),
  };
}

export async function createCustomSoundClass(name: string, isBackground: boolean): Promise<number> {
  const database = await getDetectionDatabase();
  const insertResult = await database.runAsync(
    'INSERT INTO custom_sound_classes (name, is_background, created_at) VALUES (?, ?, ?)',
    [name, isBackground ? 1 : 0, new Date().toISOString()],
  );
  return insertResult.lastInsertRowId;
}

export async function renameCustomSoundClass(classId: number, newName: string): Promise<void> {
  const database = await getDetectionDatabase();
  await database.runAsync('UPDATE custom_sound_classes SET name = ? WHERE id = ?', [newName, classId]);
}

/** Borra la clase y sus ejemplos. Las detecciones ya apuntadas en el registro se conservan. */
export async function deleteCustomSoundClass(classId: number): Promise<void> {
  const database = await getDetectionDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync('DELETE FROM custom_sound_examples WHERE class_id = ?', [classId]);
    await transaction.runAsync('DELETE FROM custom_sound_classes WHERE id = ?', [classId]);
  });
}

export async function insertCustomSoundExample(
  classId: number,
  recordedAtIso: string,
  modelVersion: string,
  embeddingFloat16Bytes: Uint8Array,
): Promise<void> {
  const database = await getDetectionDatabase();
  await database.runAsync(
    'INSERT INTO custom_sound_examples (class_id, recorded_at, model_version, embedding) VALUES (?, ?, ?, ?)',
    [classId, recordedAtIso, modelVersion, embeddingFloat16Bytes],
  );
}

/** Quita el ejemplo más reciente de una clase (para deshacer uno mal grabado). */
export async function deleteLatestCustomSoundExample(classId: number): Promise<void> {
  const database = await getDetectionDatabase();
  await database.runAsync(
    'DELETE FROM custom_sound_examples WHERE id = (SELECT MAX(id) FROM custom_sound_examples WHERE class_id = ?)',
    [classId],
  );
}
