/**
 * Migraciones del esquema. Cada entrada lleva la base de datos de la versión `índice` a la
 * `índice + 1`. **Nunca edites una migración ya publicada**: añade una nueva al final.
 */
export const schemaMigrations: readonly string[] = [
  // v1: mediciones, adjuntos y perfiles de calibración
  `
  CREATE TABLE measurements (
    id TEXT PRIMARY KEY NOT NULL,
    instrument_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    latitude REAL,
    longitude REAL,
    altitude REAL,
    location_accuracy REAL,
    values_json TEXT NOT NULL,
    calibration_profile_id TEXT,
    note TEXT
  );
  CREATE INDEX measurements_by_instrument_and_time ON measurements (instrument_id, timestamp DESC);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY NOT NULL,
    measurement_id TEXT NOT NULL REFERENCES measurements (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    file_uri TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    metadata_json TEXT
  );
  CREATE INDEX attachments_by_measurement ON attachments (measurement_id);

  CREATE TABLE calibration_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    instrument_id TEXT NOT NULL,
    device_fingerprint TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    parameters_schema_version INTEGER NOT NULL,
    parameters_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX calibration_profiles_by_instrument_and_device
    ON calibration_profiles (instrument_id, device_fingerprint);
  `,
];

/** Lo mínimo de `SQLiteDatabase` que necesitan las migraciones (facilita los tests). */
export interface MigratableDatabase {
  getFirstAsync<TRow>(sql: string): Promise<TRow | null>;
  execAsync(sql: string): Promise<void>;
  withExclusiveTransactionAsync(task: (transaction: MigratableDatabase) => Promise<void>): Promise<void>;
}

export async function migrateDatabase(
  database: MigratableDatabase,
  migrations: readonly string[] = schemaMigrations,
): Promise<number> {
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;
  if (currentVersion > migrations.length) {
    throw new Error(
      `La base de datos (v${currentVersion}) es más nueva que la app (v${migrations.length}). Actualiza la app.`,
    );
  }
  for (let targetVersion = currentVersion + 1; targetVersion <= migrations.length; targetVersion++) {
    const migrationSql = migrations[targetVersion - 1]!;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(migrationSql);
      await transaction.execAsync(`PRAGMA user_version = ${targetVersion}`);
    });
  }
  return migrations.length;
}
