import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';

const compose = process.platform === 'win32' ? 'docker.exe' : 'docker';
const projectName = 'log-service-smoke';
const applicationPort = '18080';

function runCompose(arguments_) {
  const result = spawnSync(
    compose,
    ['compose', '--project-name', projectName, ...arguments_],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_PORT: applicationPort,
        DB_PORT: '0',
        RETENTION_INTERVAL_MS: '1000',
      },
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

async function getJson(path) {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${applicationPort}${path}`,
  );
  const body = await response.json();

  return { response, body };
}

function isoTimestamp(date) {
  return date.toISOString();
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
  assert.equal(appliedMigrations, '10');

  const hstoreSchema = runCompose([
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
    `SELECT
       format_type(attribute.atttypid, attribute.atttypmod),
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'hstore'),
       'fastupdate=on' = ANY(index.reloptions),
       'gin_pending_list_limit=4096' = ANY(index.reloptions),
       to_regclass('logs_message_trgm_idx') IS NULL,
       to_regclass('log_minute_aggregates') IS NOT NULL
     FROM pg_attribute AS attribute
     CROSS JOIN pg_class AS index
     WHERE attribute.attrelid = 'logs'::regclass
       AND attribute.attname = 'attributes_text'
       AND index.oid = 'logs_attributes_text_gin_idx'::regclass`,
  ]).trim();
  assert.equal(hstoreSchema, 'hstore|t|t|t|t|t');

  const healthy = await getHealth();
  assert.equal(healthy.response.status, 200);
  assert.deepEqual(healthy.body, {
    status: 'ok',
    database: 'reachable',
  });

  const bucketStart = new Date();
  bucketStart.setUTCSeconds(0, 0);
  const firstTimestamp = isoTimestamp(new Date(bucketStart.getTime() + 10_000));
  const secondTimestamp = isoTimestamp(
    new Date(bucketStart.getTime() + 20_000),
  );
  const thirdTimestamp = isoTimestamp(new Date(bucketStart.getTime() + 30_000));
  const ingestion = await postLogs([
    {
      timestamp: firstTimestamp,
      service: 'compose-smoke',
      level: 'info',
      message: 'required contract first event',
      attributes: { attempt: 1, cached: false, region: 'west' },
    },
    {
      timestamp: secondTimestamp,
      service: 'compose-smoke',
      level: 'info',
      message: 'required contract second event',
      attributes: { attempt: 2, cached: true, region: 'west' },
    },
    {
      timestamp: thirdTimestamp,
      service: 'background-worker',
      level: 'error',
      message: 'unrelated event',
      attributes: { region: 'east' },
    },
    {
      timestamp: thirdTimestamp,
      service: 'compose-smoke',
      level: 'fatal',
      message: 'rejected ingestion check',
    },
  ]);
  assert.equal(ingestion.response.status, 200);
  assert.deepEqual(ingestion.body, {
    accepted: 3,
    rejected: [
      {
        index: 3,
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
    "SELECT service, attributes->>'attempt', attributes_text->'attempt', attributes_text->'cached' FROM logs WHERE service = 'compose-smoke' ORDER BY event_timestamp",
  ]).trim();
  assert.equal(storedLog, 'compose-smoke|1|1|false\ncompose-smoke|2|2|true');

  const storedRollup = runCompose([
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
    "SELECT count FROM log_minute_aggregates WHERE bucket_start = date_bin(INTERVAL '1 minute', TIMESTAMPTZ '" +
      firstTimestamp +
      "', TIMESTAMPTZ '2001-01-01 00:00:00+00') AND service = 'compose-smoke' AND level = 'info'",
  ]).trim();
  assert.equal(storedRollup, '2');

  const queryParameters = new URLSearchParams({
    service: 'compose-smoke',
    level: 'info',
    q: 'CONTRACT',
    'attr.region': 'west',
    limit: '1',
  });
  const firstPage = await getJson(`/logs?${queryParameters}`);
  assert.equal(firstPage.response.status, 200);
  assert.deepEqual(firstPage.body.logs, [
    {
      timestamp: secondTimestamp,
      service: 'compose-smoke',
      level: 'info',
      message: 'required contract second event',
      attributes: { cached: true, region: 'west', attempt: 2 },
    },
  ]);
  assert.equal(typeof firstPage.body.next_cursor, 'string');

  queryParameters.set('cursor', firstPage.body.next_cursor);
  const secondPage = await getJson(`/logs?${queryParameters}`);
  assert.equal(secondPage.response.status, 200);
  assert.deepEqual(secondPage.body, {
    logs: [
      {
        timestamp: firstTimestamp,
        service: 'compose-smoke',
        level: 'info',
        message: 'required contract first event',
        attributes: { cached: false, region: 'west', attempt: 1 },
      },
    ],
    next_cursor: null,
  });

  const aggregateParameters = new URLSearchParams({
    since: isoTimestamp(bucketStart),
    until: isoTimestamp(new Date(bucketStart.getTime() + 60_000)),
    bucket: '1m',
    group_by: 'level',
    service: 'compose-smoke',
    'attr.region': 'west',
  });
  const aggregation = await getJson(`/logs/aggregate?${aggregateParameters}`);
  assert.equal(aggregation.response.status, 200);
  assert.deepEqual(aggregation.body, {
    buckets: [
      {
        start: isoTimestamp(bucketStart),
        count: 2,
        group: 'info',
      },
    ],
  });

  const rollupAggregateParameters = new URLSearchParams(aggregateParameters);
  rollupAggregateParameters.delete('attr.region');
  const rollupAggregation = await getJson(
    `/logs/aggregate?${rollupAggregateParameters}`,
  );
  assert.equal(rollupAggregation.response.status, 200);
  assert.deepEqual(rollupAggregation.body, aggregation.body);

  const partialMinuteParameters = new URLSearchParams({
    since: isoTimestamp(new Date(bucketStart.getTime() + 15_000)),
    until: isoTimestamp(new Date(bucketStart.getTime() + 25_000)),
    bucket: '1m',
    service: 'compose-smoke',
  });
  const partialMinuteAggregation = await getJson(
    `/logs/aggregate?${partialMinuteParameters}`,
  );
  assert.equal(partialMinuteAggregation.response.status, 200);
  assert.deepEqual(partialMinuteAggregation.body, {
    buckets: [
      {
        start: isoTimestamp(bucketStart),
        count: 1,
        group: null,
      },
    ],
  });

  const expiredTimestamp = isoTimestamp(
    new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000),
  );
  const expiredIngestion = await postLogs([
    {
      timestamp: expiredTimestamp,
      service: 'expired-smoke',
      level: 'warn',
      message: 'retention removes raw and rollup rows',
      attributes: {},
    },
  ]);
  assert.equal(expiredIngestion.response.status, 200);
  assert.equal(expiredIngestion.body.accepted, 1);

  let retainedCounts = '1|1';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    retainedCounts = runCompose([
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
      "SELECT (SELECT COUNT(*) FROM logs WHERE service = 'expired-smoke'), (SELECT COUNT(*) FROM log_minute_aggregates WHERE service = 'expired-smoke')",
    ]).trim();
    if (retainedCounts === '0|0') break;
    await delay(500);
  }
  assert.equal(retainedCounts, '0|0');

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
  console.log('Required-contract Compose smoke test passed.');
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
