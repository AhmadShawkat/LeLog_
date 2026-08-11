import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migration-runner.js';
import { migrations, type Migration } from './migrations.js';

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function fakeDatabase(
  queryImplementation: (text: string, values?: unknown[]) => Promise<unknown>,
) {
  const query = vi.fn(queryImplementation);
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  const pool = { connect } as unknown as Pick<Pool, 'connect'>;

  return { pool, query, release, connect };
}

describe('runMigrations', () => {
  it('locks, applies pending migrations transactionally, and unlocks', async () => {
    const database = fakeDatabase(async (text) => {
      if (text.startsWith('SELECT version, checksum')) {
        return { rows: [] };
      }

      return { rows: [] };
    });

    await runMigrations(database.pool);

    const statements = database.query.mock.calls.map(([text]) => text);
    expect(statements[0]).toBe('SELECT pg_advisory_lock($1)');
    expect(statements.filter((text) => text === 'BEGIN')).toHaveLength(
      migrations.length,
    );
    expect(statements.filter((text) => text === 'COMMIT')).toHaveLength(
      migrations.length,
    );
    for (const migration of migrations) {
      expect(statements).toContain(migration.sql);
    }
    expect(statements.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    expect(database.release).toHaveBeenCalledOnce();

    const inserts = database.query.mock.calls.filter(
      ([text]) =>
        text ===
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
    );
    expect(inserts).toHaveLength(migrations.length);
    expect(inserts[0]?.[1]).toEqual([
      '001_create_logs',
      migrationChecksum(migrations[0]?.sql ?? ''),
    ]);
  });

  it('skips migrations whose stored checksums match', async () => {
    const applied = migrations.map((migration) => ({
      version: migration.version,
      checksum: migrationChecksum(migration.sql),
    }));
    const database = fakeDatabase(async (text) => ({
      rows: text.startsWith('SELECT version, checksum') ? applied : [],
    }));

    await runMigrations(database.pool);

    const statements = database.query.mock.calls.map(([text]) => text);
    expect(statements).not.toContain('BEGIN');
    expect(statements).not.toContain(migrations[0]?.sql);
    expect(database.release).toHaveBeenCalledOnce();
  });

  it('rejects changed and unknown applied migrations', async () => {
    const changed = fakeDatabase(async (text) => ({
      rows: text.startsWith('SELECT version, checksum')
        ? [{ version: '001_create_logs', checksum: 'changed' }]
        : [],
    }));
    const unknown = fakeDatabase(async (text) => ({
      rows: text.startsWith('SELECT version, checksum')
        ? [{ version: '999_unknown', checksum: 'value' }]
        : [],
    }));

    await expect(runMigrations(changed.pool)).rejects.toThrow(
      'Migration checksum mismatch for 001_create_logs',
    );
    await expect(runMigrations(unknown.pool)).rejects.toThrow(
      'Database contains unknown migration 999_unknown',
    );
    expect(changed.release).toHaveBeenCalledOnce();
    expect(unknown.release).toHaveBeenCalledOnce();
  });

  it('rolls back a failed migration and releases the client', async () => {
    const failure = new Error('schema failed');
    const migration: Migration = {
      version: '001_failure',
      sql: 'INVALID SQL',
    };
    const database = fakeDatabase(async (text) => {
      if (text.startsWith('SELECT version, checksum')) {
        return { rows: [] };
      }

      if (text === migration.sql) {
        throw failure;
      }

      return { rows: [] };
    });

    await expect(runMigrations(database.pool, [migration])).rejects.toBe(
      failure,
    );

    const statements = database.query.mock.calls.map(([text]) => text);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(statements.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    expect(database.release).toHaveBeenCalledOnce();
  });

  it('validates migration ordering before acquiring a client', async () => {
    const database = fakeDatabase(async () => ({ rows: [] }));

    await expect(
      runMigrations(database.pool, [
        { version: '002_second', sql: 'SELECT 2' },
        { version: '001_first', sql: 'SELECT 1' },
      ]),
    ).rejects.toThrow('Migrations must be ordered by version');
    expect(database.connect).not.toHaveBeenCalled();
  });
});
