import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { type DetectionRecord, type DetectionRow, type NewDetectionRecord, rowToDetectionRecord } from './detectionLog';

/**
 * Base de datos propia del instrumento (la del núcleo solo guarda mediciones y calibraciones y
 * sus migraciones son compartidas). Una fila por detección, con el embedding en float16.
 */
const databaseName = 'wildlife-sounds.db';

/** Migraciones: cada entrada lleva la base de la versión `índice` a la `índice + 1`. Añade las nuevas al final. */
const schemaStatements: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_at TEXT NOT NULL,
    duration_seconds REAL NOT NULL,
    latitude REAL,
    longitude REAL,
    species_label TEXT NOT NULL,
    species_score REAL NOT NULL,
    top_classes_json TEXT NOT NULL,
    model_version TEXT NOT NULL,
    embedding BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS detections_by_time ON detections (detected_at DESC);
  `,
  // 2: clases propias («Enséñale tus sonidos»): sus ejemplos (solo embeddings) y la marca en el registro.
  `
  ALTER TABLE detections ADD COLUMN is_custom_class INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS custom_sound_classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_background INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS custom_sound_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    model_version TEXT NOT NULL,
    embedding BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS custom_sound_examples_by_class ON custom_sound_examples (class_id);
  `,
];

let databasePromise: Promise<SQLiteDatabase> | null = null;

async function openAndPrepareDatabase(): Promise<SQLiteDatabase> {
  const database = await openDatabaseAsync(databaseName);
  await database.execAsync('PRAGMA journal_mode = WAL;');
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;
  for (let statementIndex = currentVersion; statementIndex < schemaStatements.length; statementIndex++) {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(schemaStatements[statementIndex]!);
      await transaction.execAsync(`PRAGMA user_version = ${statementIndex + 1}`);
    });
  }
  return database;
}

/** Base de datos del instrumento (también la usa customSoundStore.ts). */
export function getDetectionDatabase(): Promise<SQLiteDatabase> {
  databasePromise ??= openAndPrepareDatabase().catch((openError: unknown) => {
    databasePromise = null;
    throw openError;
  });
  return databasePromise;
}

export async function insertDetection(newRecord: NewDetectionRecord): Promise<void> {
  const database = await getDetectionDatabase();
  await database.runAsync(
    `INSERT INTO detections
       (detected_at, duration_seconds, latitude, longitude, species_label, species_score,
        top_classes_json, model_version, embedding, is_custom_class)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newRecord.detectedAtIso,
      newRecord.durationSeconds,
      newRecord.latitude,
      newRecord.longitude,
      newRecord.speciesLabel,
      newRecord.speciesScore,
      JSON.stringify(newRecord.topClasses),
      newRecord.modelVersion,
      newRecord.embeddingFloat16Bytes,
      newRecord.isCustomClass ? 1 : 0,
    ],
  );
}

export interface DetectionStatistics {
  detectionCount: number;
  distinctSpeciesCount: number;
}

export async function readDetectionStatistics(): Promise<DetectionStatistics> {
  const database = await getDetectionDatabase();
  const statisticsRow = await database.getFirstAsync<{ detection_count: number; distinct_species_count: number }>(
    `SELECT COUNT(*) AS detection_count,
            COUNT(DISTINCT CASE WHEN is_custom_class = 0 THEN species_label END) AS distinct_species_count
       FROM detections`,
  );
  return {
    detectionCount: statisticsRow?.detection_count ?? 0,
    distinctSpeciesCount: statisticsRow?.distinct_species_count ?? 0,
  };
}

export async function listRecentDetections(maximumCount: number): Promise<DetectionRecord[]> {
  const database = await getDetectionDatabase();
  const detectionRows = await database.getAllAsync<DetectionRow>(
    'SELECT * FROM detections ORDER BY detected_at DESC, id DESC LIMIT ?',
    [maximumCount],
  );
  return detectionRows.map(rowToDetectionRecord);
}

/** Todas, de la más antigua a la más reciente (para exportar). */
export async function listAllDetections(): Promise<DetectionRecord[]> {
  const database = await getDetectionDatabase();
  const detectionRows = await database.getAllAsync<DetectionRow>('SELECT * FROM detections ORDER BY detected_at, id');
  return detectionRows.map(rowToDetectionRecord);
}

export async function deleteAllDetections(): Promise<void> {
  const database = await getDetectionDatabase();
  await database.runAsync('DELETE FROM detections');
}
