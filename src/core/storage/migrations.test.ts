import { type MigratableDatabase, migrateDatabase, schemaMigrations } from './migrations';

function createFakeDatabase(initialVersion: number) {
  const executedStatements: string[] = [];
  let userVersion = initialVersion;
  const fakeDatabase: MigratableDatabase = {
    async getFirstAsync<TRow>() {
      return { user_version: userVersion } as TRow;
    },
    async execAsync(sql) {
      executedStatements.push(sql.trim());
      const versionMatch = /^PRAGMA user_version = (\d+)$/.exec(sql.trim());
      if (versionMatch) userVersion = Number(versionMatch[1]);
    },
    async withExclusiveTransactionAsync(task) {
      await task(fakeDatabase);
    },
  };
  return { fakeDatabase, executedStatements, readUserVersion: () => userVersion };
}

describe('migrateDatabase', () => {
  const exampleMigrations = ['CREATE TABLE a (id)', 'CREATE TABLE b (id)', 'CREATE TABLE c (id)'];

  it('aplica todas las migraciones a una base de datos nueva, en orden', async () => {
    const { fakeDatabase, executedStatements, readUserVersion } = createFakeDatabase(0);
    await migrateDatabase(fakeDatabase, exampleMigrations);
    expect(executedStatements).toEqual([
      'CREATE TABLE a (id)',
      'PRAGMA user_version = 1',
      'CREATE TABLE b (id)',
      'PRAGMA user_version = 2',
      'CREATE TABLE c (id)',
      'PRAGMA user_version = 3',
    ]);
    expect(readUserVersion()).toBe(3);
  });

  it('solo aplica las migraciones pendientes', async () => {
    const { fakeDatabase, executedStatements } = createFakeDatabase(2);
    await migrateDatabase(fakeDatabase, exampleMigrations);
    expect(executedStatements).toEqual(['CREATE TABLE c (id)', 'PRAGMA user_version = 3']);
  });

  it('no hace nada si ya está al día', async () => {
    const { fakeDatabase, executedStatements } = createFakeDatabase(3);
    await migrateDatabase(fakeDatabase, exampleMigrations);
    expect(executedStatements).toEqual([]);
  });

  it('se niega a abrir una base de datos de una versión futura de la app', async () => {
    const { fakeDatabase } = createFakeDatabase(9);
    await expect(migrateDatabase(fakeDatabase, exampleMigrations)).rejects.toThrow('más nueva');
  });

  it('las migraciones reales no están vacías', () => {
    expect(schemaMigrations.length).toBeGreaterThan(0);
    for (const migrationSql of schemaMigrations) expect(migrationSql.trim()).not.toBe('');
  });
});
