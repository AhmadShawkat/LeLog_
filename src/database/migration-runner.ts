import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { migrations, type Migration } from './migrations.js';

const migrationLockId = 1_934_826_237;

interface AppliedMigration extends QueryResultRow {
  version: string;
  checksum: string;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function validateMigrations(orderedMigrations: readonly Migration[]): void {
  const versions = orderedMigrations.map(({ version }) => version);
  const uniqueVersions = new Set(versions);
  const sortedVersions = [...versions].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  if (uniqueVersions.size !== versions.length) {
    throw new Error('Migration versions must be unique');
  }

  if (versions.some((version, index) => version !== sortedVersions[index])) {
    throw new Error('Migrations must be ordered by version');
  }
}

async function applyMigration(
  client: PoolClient,
  migration: Migration,
  migrationChecksum: string,
): Promise<void> {
  await client.query('BEGIN');

  try {
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
      [migration.version, migrationChecksum],
    );
    await client.query('COMMIT');
  } catch (migrationError) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [migrationError, rollbackError],
        `Migration ${migration.version} failed and rollback also failed`,
        { cause: rollbackError },
      );
    }

    throw migrationError;
  }
}

export async function runMigrations(
  pool: Pick<Pool, 'connect'>,
  orderedMigrations: readonly Migration[] = migrations,
): Promise<void> {
  validateMigrations(orderedMigrations);
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);

    const appliedResult = await client.query<AppliedMigration>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const knownMigrations = new Map(
      orderedMigrations.map((migration) => [migration.version, migration]),
    );
    const appliedMigrations = new Map(
      appliedResult.rows.map((migration) => [migration.version, migration]),
    );

    for (const applied of appliedResult.rows) {
      const known = knownMigrations.get(applied.version);

      if (!known) {
        throw new Error(
          `Database contains unknown migration ${applied.version}`,
        );
      }

      if (checksum(known.sql) !== applied.checksum) {
        throw new Error(`Migration checksum mismatch for ${applied.version}`);
      }
    }

    for (const migration of orderedMigrations) {
      if (appliedMigrations.has(migration.version)) {
        continue;
      }

      await applyMigration(client, migration, checksum(migration.sql));
    }
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]);
      }
    } finally {
      client.release();
    }
  }
}
