import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { migrateDatabase } from './migrations';

const databaseName = 'laboratorio.db';

let databasePromise: Promise<SQLiteDatabase> | null = null;

async function openAndMigrateDatabase(): Promise<SQLiteDatabase> {
  const database = await openDatabaseAsync(databaseName);
  await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await migrateDatabase(database);
  return database;
}

/** Base de datos compartida por toda la app; se abre y migra la primera vez que se pide. */
export function getDatabase(): Promise<SQLiteDatabase> {
  databasePromise ??= openAndMigrateDatabase().catch((openError: unknown) => {
    databasePromise = null;
    throw openError;
  });
  return databasePromise;
}
