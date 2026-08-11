import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const compose = process.platform === 'win32' ? 'docker.exe' : 'docker';
const projectName = 'log-service-smoke';
const applicationPort = '18080';

function runCompose(arguments_) {
  const result = spawnSync(
    compose,
    ['compose', '--project-name', projectName, ...arguments_],
    {
      encoding: 'utf8',
      env: { ...process.env, APP_PORT: applicationPort, DB_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `docker compose ${arguments_.join(' ')} failed\n${result.stdout}${result.stderr}`,
    );
  }

  return result.stdout;
}

async function getHealth() {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${applicationPort}/health`,
  );
  const body = await response.json();

  return { response, body };
}

async function postLogs(entries) {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${applicationPort}/logs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logs: entries }),
    },
  );
  const body = await response.json();

  return { response, body };
}

async function runSmokeTest() {
  runCompose(['up', '--build', '--detach', '--wait']);
  runCompose([
    'exec',
    '--no-TTY',
    'application',
    'node',
    '-e',
    'if (process.getuid?.() === 0) process.exit(1)',
  ]);
  const appliedMigrations = runCompose([
    'exec',
    '--no-TTY',
    'database',
    'psql',
    '--username',
    'log_service',
    '--dbname',
    'log_service',
    '--tuples-only',
    '--no-align',
    '--command',
    'SELECT count(*) FROM schema_migrations',
  ]).trim();
  assert.equal(appliedMigrations, '2');

  const healthy = await getHealth();
  assert.equal(healthy.response.status, 200);
  assert.deepEqual(healthy.body, {
    status: 'ok',
    database: 'reachable',
  });

  const timestamp = new Date().toISOString();
  const ingestion = await postLogs([
    {
      timestamp,
      service: 'compose-smoke',
      level: 'info',
      message: 'durable ingestion check',
      attributes: { attempt: 1, cached: false },
    },
    {
      timestamp,
      service: 'compose-smoke',
      level: 'fatal',
      message: 'rejected ingestion check',
    },
  ]);
  assert.equal(ingestion.response.status, 200);
  assert.deepEqual(ingestion.body, {
    accepted: 1,
    rejected: [
      {
        index: 1,
        reason: 'level must be one of debug, info, warn, or error',
      },
    ],
  });

  const storedLog = runCompose([
    'exec',
    '--no-TTY',
    'database',
    'psql',
    '--username',
    'log_service',
    '--dbname',
    'log_service',
    '--tuples-only',
    '--no-align',
    '--field-separator',
    '|',
    '--command',
    "SELECT service, attributes->>'attempt', attributes_text->>'attempt', attributes_text->>'cached' FROM logs",
  ]).trim();
  assert.equal(storedLog, 'compose-smoke|1|1|false');

  runCompose(['stop', 'database']);

  let unavailable;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      unavailable = await getHealth();
      if (unavailable.response.status === 503) break;
    } catch {
      // The application may briefly restart when its dependency stops.
    }
    await delay(500);
  }

  assert.ok(unavailable, 'health endpoint did not respond after database stop');
  assert.equal(unavailable.response.status, 503);
  assert.deepEqual(unavailable.body, {
    status: 'unavailable',
    database: 'unreachable',
  });
  console.log('Compose service smoke test passed.');
}

async function main() {
  let smokeError;

  try {
    await runSmokeTest();
  } catch (error) {
    smokeError = error;
  }

  try {
    runCompose(['down', '--volumes', '--remove-orphans']);
  } catch (cleanupError) {
    if (smokeError) {
      throw new AggregateError(
        [smokeError, cleanupError],
        'Compose smoke test and cleanup both failed',
        { cause: cleanupError },
      );
    }

    throw cleanupError;
  }

  if (smokeError) throw smokeError;
}

await main();
