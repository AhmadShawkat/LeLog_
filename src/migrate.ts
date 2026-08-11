import { loadConfig } from './config.js';
import { runMigrations } from './database/migration-runner.js';
import { createDatabasePool } from './database/pool.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createDatabasePool(config);

  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(`Failed to migrate database: ${errorMessage(error)}`);
  process.exitCode = 1;
});
