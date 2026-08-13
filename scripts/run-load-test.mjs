import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const runSuffix = new Date().toISOString().replaceAll(/[-:.TZ]/g, '');
const projectName = `log-service-load-${runSuffix}`;
const k6Image = 'grafana/k6:2.1.0';
const quick = process.argv.includes('--quick');
const grader = process.argv.includes('--grader');
const unexpectedArguments = process.argv
  .slice(2)
  .filter((value) => value !== '--quick' && value !== '--grader');

if (unexpectedArguments.length > 0) {
  throw new Error(`Unsupported arguments: ${unexpectedArguments.join(', ')}`);
}
if (quick && grader) {
  throw new Error('--quick and --grader cannot be combined');
}

const profile = quick
  ? {
      totalLogs: 10_000,
      seedLogs: 5_000,
      mixedLogs: 5_000,
      batchSize: 100,
      mixedBatchRate: 5,
      mixedDurationSeconds: 10,
      aggregationWindowHours: 24,
      seedVus: 5,
      maximumIngestionVus: 20,
    }
  : grader
    ? {
        totalLogs: 1_810_000,
        seedLogs: 10_000,
        mixedLogs: 1_800_000,
        batchSize: 100,
        mixedBatchRate: 150,
        mixedDurationSeconds: 120,
        aggregationWindowHours: 24,
        seedVus: 4,
        maximumIngestionVus: 600,
      }
    : {
        totalLogs: 1_000_000,
        seedLogs: 860_000,
        mixedLogs: 320_000,
        batchSize: 1_000,
        mixedBatchRate: 16,
        mixedDurationSeconds: 20,
        aggregationWindowHours: 24,
        seedVus: 4,
        maximumIngestionVus: 60,
      };

const runId = `load-${runSuffix}`;
const resultsDirectory = path.join(repositoryRoot, 'load-results', runId);
const composeEnvironment = {
  ...process.env,
  APP_PORT: '0',
  DB_PORT: '0',
  LOG_LEVEL: 'warn',
  RETENTION_DAYS: '31',
  RETENTION_INTERVAL_MS: '86400000',
};
const resourceSamples = [];

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${arguments_.join(' ')} failed with exit code ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function runCompose(arguments_, options = {}) {
  return run(
    docker,
    ['compose', '--project-name', projectName, ...arguments_],
    { ...options, env: composeEnvironment },
  );
}

function composeContainerId(service) {
  return runCompose(['ps', '--quiet', service]).stdout.trim();
}

function parseDockerPercentage(value) {
  return Number.parseFloat(value.replace('%', '').trim());
}

function parseByteValue(value) {
  const match = value.trim().match(/^([\d.]+)([kmgt]?i?b)$/i);
  if (!match) return undefined;
  const number = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000 ** 2,
    mib: 1_024 ** 2,
    gb: 1_000 ** 3,
    gib: 1_024 ** 3,
    tb: 1_000 ** 4,
    tib: 1_024 ** 4,
  };
  return number * multipliers[unit];
}

async function sampleResources(phase, containerIds) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      docker,
      ['stats', '--no-stream', '--format', '{{json .}}', ...containerIds],
      { cwd: repositoryRoot, encoding: 'utf8' },
    ));
  } catch {
    return;
  }

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const sample = JSON.parse(line);
    const [memoryUsage] = sample.MemUsage.split('/');
    resourceSamples.push({
      phase,
      sampledAt: new Date().toISOString(),
      container: sample.Name,
      cpuPercent: parseDockerPercentage(sample.CPUPerc),
      memoryBytes: parseByteValue(memoryUsage),
      memoryPercent: parseDockerPercentage(sample.MemPerc),
      blockIo: sample.BlockIO,
      networkIo: sample.NetIO,
      pids: Number(sample.PIDs),
    });
  }
}

async function runK6Phase(phase, datasetEndMs, containerIds) {
  const summaryFile = `${phase}-summary.json`;
  const volumePath = (value) =>
    process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  const k6Arguments = [
    'run',
    '--rm',
    '--network',
    `${projectName}_default`,
    '--volume',
    `${volumePath(path.join(repositoryRoot, 'load-tests'))}:/scripts:ro`,
    '--volume',
    `${volumePath(resultsDirectory)}:/results`,
  ];
  const variables = {
    TEST_PHASE: phase,
    BASE_URL: 'http://application:8080',
    RUN_ID: runId,
    DATASET_END_MS: String(datasetEndMs),
    TOTAL_LOGS: String(profile.totalLogs),
    SEED_LOGS: String(profile.seedLogs),
    MIXED_LOGS: String(profile.mixedLogs),
    BATCH_SIZE: String(profile.batchSize),
    MIXED_BATCH_RATE: String(profile.mixedBatchRate),
    MIXED_DURATION_SECONDS: String(profile.mixedDurationSeconds),
    AGGREGATION_WINDOW_HOURS: String(profile.aggregationWindowHours),
    SEED_VUS: String(profile.seedVus),
    MAXIMUM_INGESTION_VUS: String(profile.maximumIngestionVus),
    SUMMARY_PATH: `/results/${summaryFile}`,
  };
  for (const [name, value] of Object.entries(variables)) {
    k6Arguments.push('--env', `${name}=${value}`);
  }
  k6Arguments.push(k6Image, 'run', '/scripts/k6-load-test.js');

  console.log(`Running k6 ${phase} phase...`);
  const scheduledRate = profile.mixedBatchRate * profile.batchSize;
  if (phase === 'mixed') {
    console.log(
      `[mixed] scheduled ingestion: ${scheduledRate.toLocaleString('en-US')} logs/s (${profile.batchSize.toLocaleString('en-US')} logs per batch)`,
    );
  } else {
    console.log(
      `[seed] ingesting ${profile.seedLogs.toLocaleString('en-US')} logs in ${profile.batchSize.toLocaleString('en-US')}-log batches; measured logs/s prints at phase end`,
    );
  }
  const child = spawn(docker, k6Arguments, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let finished = false;
  const progressReporter = (async () => {
    while (!finished) {
      await delay(1_000);
      if (finished) break;
      if (phase === 'mixed') {
        console.log(
          `[mixed] scheduled ingestion remains ${scheduledRate.toLocaleString('en-US')} logs/s`,
        );
      }
    }
  })();
  const sampler = (async () => {
    while (!finished) {
      await sampleResources(phase, containerIds);
      await delay(1_000);
    }
  })();
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  finished = true;
  await progressReporter;
  await sampler;
  await sampleResources(phase, containerIds);
  assert.ok(
    exitCode === 0 || exitCode === 99,
    `k6 ${phase} phase exited unexpectedly with code ${exitCode}`,
  );

  const summary = JSON.parse(
    await readFile(path.join(resultsDirectory, summaryFile), 'utf8'),
  );
  summary.thresholdsPassed = exitCode === 0;
  const accepted = metric(summary, 'accepted_logs');
  console.log(
    `[${phase}] measured accepted throughput: ${accepted.rate.toLocaleString('en-US', { maximumFractionDigits: 0 })} logs/s (${accepted.count.toLocaleString('en-US')} logs)`,
  );
  return summary;
}

function queryDatabase(sql, variables = {}) {
  const arguments_ = [
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
  ];
  for (const [name, value] of Object.entries(variables)) {
    arguments_.push('--set', `${name}=${value}`);
  }
  arguments_.push('--set', 'ON_ERROR_STOP=1');
  return runCompose(arguments_, {
    input: `${sql}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).stdout.trim();
}

function readDatabaseStatistics() {
  return JSON.parse(
    queryDatabase(`
      SELECT json_build_object(
        'captured_at', clock_timestamp(),
        'wal', (SELECT to_jsonb(wal) FROM pg_stat_wal AS wal),
        'io', (SELECT json_agg(to_jsonb(io)) FROM pg_stat_io AS io),
        'table_activity', (
          SELECT to_jsonb(activity)
          FROM pg_stat_user_tables AS activity
          WHERE relname = 'logs'
        )
      );
    `),
  );
}

function inspectResourceLimits(containerIds) {
  const inspection = JSON.parse(
    run(docker, ['inspect', ...containerIds]).stdout,
  );
  const byName = Object.fromEntries(
    inspection.map((container) => [
      container.Name.replace(/^\//, ''),
      {
        nanoCpus: container.HostConfig.NanoCpus,
        memoryBytes: container.HostConfig.Memory,
      },
    ]),
  );
  const application = byName[`${projectName}-application-1`];
  const database = byName[`${projectName}-database-1`];
  assert.deepEqual(application, {
    nanoCpus: 500_000_000,
    memoryBytes: 256 * 1_024 * 1_024,
  });
  assert.deepEqual(database, {
    nanoCpus: 1_000_000_000,
    memoryBytes: 1_024 * 1_024 * 1_024,
  });
  return { application, database };
}

function metric(summary, name) {
  return summary.metrics[name]?.values;
}

function assertRateIsOne(summary, name) {
  assert.equal(
    metric(summary, name)?.rate,
    1,
    `${name} did not remain at 100%`,
  );
}

function summarizeResources() {
  const result = {};
  for (const sample of resourceSamples) {
    const current = result[sample.container] ?? {
      maximumCpuPercent: 0,
      maximumMemoryBytes: 0,
      maximumMemoryPercent: 0,
      samples: 0,
    };
    current.maximumCpuPercent = Math.max(
      current.maximumCpuPercent,
      sample.cpuPercent,
    );
    current.maximumMemoryBytes = Math.max(
      current.maximumMemoryBytes,
      sample.memoryBytes ?? 0,
    );
    current.maximumMemoryPercent = Math.max(
      current.maximumMemoryPercent,
      sample.memoryPercent,
    );
    current.samples += 1;
    result[sample.container] = current;
  }
  return result;
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  });
}

function formatPercent(rate) {
  return `${(Number(rate ?? 0) * 100).toFixed(1)}%`;
}

function formatMilliseconds(value) {
  return `${Number(value ?? 0).toFixed(1)} ms`;
}

function formatBytes(value) {
  return `${(Number(value ?? 0) / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function targetLabel(met) {
  return met ? 'PASS' : 'MISS';
}

function printStatistics(report, reportPath) {
  const mixed = report.metrics.mixed;
  const resources = Object.entries(report.resourceSummary);
  const application = resources.find(([name]) =>
    name.endsWith('-application-1'),
  )?.[1];
  const database = resources.find(([name]) =>
    name.endsWith('-database-1'),
  )?.[1];

  console.log('\n================ LOAD TEST STATISTICS ================');
  console.log(`Run: ${report.runId} (${report.profileName} profile)`);
  console.log('Dataset');
  console.log(
    `  Durable workload logs: ${formatNumber(report.databaseEvidence.main_log_count)}`,
  );
  console.log(
    `  Event-time range:      ${report.databaseEvidence.minimum_timestamp} to ${report.databaseEvidence.maximum_timestamp}`,
  );
  console.log(
    `  Database / logs size:  ${formatBytes(report.databaseEvidence.database_bytes)} / ${formatBytes(report.databaseEvidence.logs_table_bytes)}`,
  );
  console.log('Ingestion during concurrent traffic');
  console.log(
    `  Scheduled rate:        ${formatNumber(report.targetAssessment.scheduledIngestionLogsPerSecond)} logs/s`,
  );
  console.log(
    `  Accepted rate:         ${formatNumber(mixed.acceptedLogs?.rate)} logs/s`,
  );
  console.log(
    `  Accepted logs:         ${formatNumber(mixed.acceptedLogs?.count)}`,
  );
  console.log(
    `  Successful requests:   ${formatPercent(mixed.ingestionSuccess?.rate)}`,
  );
  console.log(
    `  Dropped iterations:    ${formatNumber(mixed.droppedIterations?.count)}`,
  );
  console.log(
    `  Ingestion latency p95: ${formatMilliseconds(mixed.ingestionLatencyMs?.['p(95)'])}`,
  );
  console.log('Queries and aggregation during ingestion');
  console.log(
    `  Query success / p95:   ${formatPercent(mixed.querySuccess?.rate)} / ${formatMilliseconds(mixed.queryLatencyMs?.['p(95)'])}`,
  );
  console.log('  Aggregate rate:        1 request/s scheduled');
  console.log(
    `  Aggregate success/p95: ${formatPercent(mixed.aggregationSuccess?.rate)} / ${formatMilliseconds(mixed.aggregationLatencyMs?.['p(95)'])}`,
  );
  console.log(
    `  Visibility success/max:${formatPercent(mixed.visibilitySuccess?.rate)} / ${formatMilliseconds(mixed.visibilityLagMs?.max)}`,
  );
  console.log('Peak container usage');
  console.log(
    `  Application CPU/RAM:   ${Number(application?.maximumCpuPercent ?? 0).toFixed(1)}% / ${formatBytes(application?.maximumMemoryBytes)}`,
  );
  console.log(
    `  PostgreSQL CPU/RAM:    ${Number(database?.maximumCpuPercent ?? 0).toFixed(1)}% / ${formatBytes(database?.maximumMemoryBytes)}`,
  );
  console.log('Required-target assessment');
  console.log(
    `  Approx. 1M durable:     ${targetLabel(report.targetAssessment.approximatelyOneMillionDurableRows)}`,
  );
  console.log(
    `  At least 15,000 logs/s: ${targetLabel(report.targetAssessment.ingestionTargetMet)}`,
  );
  console.log(
    `  Responsive queries:     ${targetLabel(report.targetAssessment.queriesResponsive)}`,
  );
  console.log(
    `  Aggregation p95 < 1s:   ${targetLabel(report.targetAssessment.aggregationP95BelowOneSecond)}`,
  );
  console.log(
    `  Visibility < 20s:       ${targetLabel(report.targetAssessment.visibilityMaximumBelowTwentySeconds)}`,
  );
  console.log(`Full JSON report: ${reportPath}`);
  console.log('======================================================\n');
}

async function runLoadTest() {
  await mkdir(resultsDirectory, { recursive: true });
  run(docker, ['info']);
  runCompose(['down', '--volumes', '--remove-orphans', '--rmi', 'local']);
  runCompose(['up', '--build', '--detach', '--wait'], { stdio: 'inherit' });

  const containerIds = [
    composeContainerId('application'),
    composeContainerId('database'),
  ];
  assert.ok(containerIds.every(Boolean), 'Compose containers are not running');
  const resourceLimits = inspectResourceLimits(containerIds);
  assert.equal(
    Number(queryDatabase('SELECT COUNT(*) FROM logs;')),
    0,
    'load-test database did not start empty',
  );
  const datasetEndMs = Date.now() - 60_000;

  const seedSummary = await runK6Phase('seed', datasetEndMs, containerIds);
  assert.equal(
    seedSummary.thresholdsPassed,
    true,
    'seed phase thresholds failed',
  );
  assertRateIsOne(seedSummary, 'ingestion_success');
  const seedCount = Number(
    queryDatabase(
      "SELECT COUNT(*) FROM logs WHERE attributes_text ->> 'run_id' = :'run_id';",
      { run_id: runId },
    ),
  );
  assert.equal(seedCount, profile.seedLogs, 'seed row count is not durable');

  console.log('Stabilizing the seeded dataset before measured traffic...');
  const stabilizationStartedAt = Date.now();
  queryDatabase('VACUUM ANALYZE logs;\nCHECKPOINT;');
  const stabilizationDurationMs = Date.now() - stabilizationStartedAt;
  console.log(
    `[stabilization] VACUUM ANALYZE and CHECKPOINT completed in ${formatMilliseconds(stabilizationDurationMs)}`,
  );

  const databaseStatisticsBeforeMixed = readDatabaseStatistics();
  const mixedSummary = await runK6Phase('mixed', datasetEndMs, containerIds);
  const databaseStatisticsAfterMixed = readDatabaseStatistics();
  const durableMainLogCount =
    metric(seedSummary, 'accepted_logs').count +
    metric(mixedSummary, 'accepted_logs').count;
  const databaseEvidence = JSON.parse(
    queryDatabase(
      `SELECT json_build_object(
        'main_log_count', COUNT(*) FILTER (WHERE attributes_text ->> 'run_id' = :'run_id'),
        'probe_log_count', COUNT(*) FILTER (WHERE attributes_text ->> 'run_id' = :'probe_run_id'),
        'minimum_timestamp', MIN(event_timestamp) FILTER (WHERE attributes_text ->> 'run_id' = :'run_id'),
        'maximum_timestamp', MAX(event_timestamp) FILTER (WHERE attributes_text ->> 'run_id' = :'run_id'),
        'database_bytes', pg_database_size(current_database()),
        'logs_table_bytes', pg_total_relation_size('logs'),
        'logs_heap_bytes', pg_relation_size('logs'),
        'settings', (
          SELECT json_object_agg(
            name,
            json_build_object('setting', setting, 'unit', unit)
            ORDER BY name
          )
          FROM pg_settings
          WHERE name IN (
            'shared_buffers',
            'effective_cache_size',
            'work_mem',
            'wal_buffers',
            'gin_pending_list_limit',
            'max_wal_size',
            'min_wal_size',
            'checkpoint_timeout',
            'checkpoint_completion_target',
            'wal_compression',
            'random_page_cost',
            'jit',
            'max_connections',
            'autovacuum_naptime',
            'autovacuum_vacuum_scale_factor',
            'autovacuum_analyze_scale_factor',
            'autovacuum_vacuum_cost_limit',
            'autovacuum_vacuum_cost_delay',
            'fsync',
            'full_page_writes',
            'synchronous_commit'
          )
        ),
        'index_bytes', (
          SELECT json_object_agg(indexrelid::regclass::text, pg_relation_size(indexrelid))
          FROM pg_index
          WHERE indrelid = 'logs'::regclass
        ),
        'index_definitions', (
          SELECT json_object_agg(indexname, indexdef ORDER BY indexname)
          FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'logs'
        ),
        'index_options', (
          SELECT json_object_agg(indexrelid::regclass::text, COALESCE(index_class.reloptions, ARRAY[]::text[]))
          FROM pg_index
          JOIN pg_class AS index_class ON index_class.oid = indexrelid
          WHERE indrelid = 'logs'::regclass
        ),
        'checkpointer', (SELECT to_jsonb(checkpointer) FROM pg_stat_checkpointer AS checkpointer),
        'wal', (SELECT to_jsonb(wal) FROM pg_stat_wal AS wal),
        'table_activity', (
          SELECT to_jsonb(activity)
          FROM pg_stat_user_tables AS activity
          WHERE relname = 'logs'
        )
      ) FROM logs;`,
      { run_id: runId, probe_run_id: `${runId}-probe` },
    ),
  );
  assert.equal(
    Number(databaseEvidence.main_log_count),
    durableMainLogCount,
    'accepted main logs are not durable',
  );
  const commonPlanVariables = {
    run_id: runId,
    until: new Date(datasetEndMs + 1).toISOString(),
  };
  const filteredQueryPlanVariables = {
    ...commonPlanVariables,
    since: new Date(datasetEndMs - 30 * 24 * 60 * 60 * 1_000).toISOString(),
  };
  const aggregationPlanVariables = {
    ...commonPlanVariables,
    since: new Date(
      datasetEndMs - profile.aggregationWindowHours * 60 * 60 * 1_000,
    ).toISOString(),
  };
  const queryPlans = {
    filteredQuery: JSON.parse(
      queryDatabase(
        `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)
         SELECT id, event_timestamp, service, level, message, attributes
         FROM logs
         WHERE service = 'load-api-0'
           AND event_timestamp >= :'since'::timestamptz
           AND event_timestamp < :'until'::timestamptz
           AND attributes_text @> jsonb_build_object('run_id', :'run_id')
         ORDER BY event_timestamp DESC, id DESC
         LIMIT 101;`,
        filteredQueryPlanVariables,
      ),
    ),
    aggregation: JSON.parse(
      queryDatabase(
        `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)
         SELECT
           date_bin(
             INTERVAL '1 hour',
             event_timestamp,
             TIMESTAMPTZ '2001-01-01 00:00:00+00'
           ) AS bucket_timestamp,
           service AS group_value,
           COUNT(*)::bigint AS count
         FROM logs
         WHERE event_timestamp >= :'since'::timestamptz
           AND event_timestamp < :'until'::timestamptz
           AND attributes_text @> jsonb_build_object('run_id', :'run_id')
         GROUP BY bucket_timestamp, group_value
         ORDER BY bucket_timestamp ASC, group_value ASC NULLS FIRST;`,
        aggregationPlanVariables,
      ),
    ),
  };

  const report = {
    runId,
    quick,
    profileName: quick ? 'quick' : grader ? 'grader' : 'full',
    startedFromCommit: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
    measuredAt: new Date().toISOString(),
    host: {
      platform: `${os.platform()} ${os.release()}`,
      architecture: os.arch(),
      logicalCpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      totalMemoryBytes: os.totalmem(),
      dockerServerVersion: JSON.parse(
        run(docker, ['info', '--format', '{{json .ServerVersion}}']).stdout,
      ),
      k6Image,
    },
    profile,
    resourceLimits,
    stabilizationDurationMs,
    databaseEvidence,
    databaseStatisticsBeforeMixed,
    databaseStatisticsAfterMixed,
    queryPlans,
    metrics: {
      seed: {
        acceptedLogs: metric(seedSummary, 'accepted_logs'),
        ingestionLatencyMs: metric(seedSummary, 'ingestion_latency_ms'),
      },
      mixed: {
        acceptedLogs: metric(mixedSummary, 'accepted_logs'),
        ingestionSuccess: metric(mixedSummary, 'ingestion_success'),
        ingestionLatencyMs: metric(mixedSummary, 'ingestion_latency_ms'),
        querySuccess: metric(mixedSummary, 'query_success'),
        queryLatencyMs: metric(mixedSummary, 'query_latency_ms'),
        aggregationSuccess: metric(mixedSummary, 'aggregation_success'),
        aggregationLatencyMs: metric(mixedSummary, 'aggregation_latency_ms'),
        visibilitySuccess: metric(mixedSummary, 'visibility_success'),
        visibilityLagMs: metric(mixedSummary, 'visibility_lag_ms'),
        droppedIterations: metric(mixedSummary, 'dropped_iterations'),
      },
    },
    targetAssessment: {
      approximatelyOneMillionDurableRows:
        durableMainLogCount >= profile.totalLogs * 0.9 &&
        durableMainLogCount <= profile.totalLogs * 1.2,
      scheduledIngestionLogsPerSecond:
        profile.mixedBatchRate * profile.batchSize,
      ingestionTargetMet:
        metric(mixedSummary, 'accepted_logs')?.rate >=
          (quick ? profile.mixedBatchRate * profile.batchSize : 15_000) &&
        metric(mixedSummary, 'ingestion_success')?.rate === 1 &&
        (metric(mixedSummary, 'dropped_iterations')?.count ?? 0) === 0,
      queriesResponsive:
        metric(mixedSummary, 'query_success')?.rate === 1 &&
        metric(mixedSummary, 'query_latency_ms')?.['p(95)'] < 1_000,
      aggregationP95BelowOneSecond:
        metric(mixedSummary, 'aggregation_success')?.rate === 1 &&
        metric(mixedSummary, 'aggregation_latency_ms')?.['p(95)'] < 1_000,
      visibilityMaximumBelowTwentySeconds:
        metric(mixedSummary, 'visibility_success')?.rate === 1 &&
        metric(mixedSummary, 'visibility_lag_ms')?.max < 20_000,
    },
    resourceSummary: summarizeResources(),
    resourceSamples,
  };
  const reportPath = path.join(resultsDirectory, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, undefined, 2)}\n`);
  printStatistics(report, reportPath);
}

let loadTestError;
try {
  await runLoadTest();
} catch (error) {
  loadTestError = error;
  const logs = runCompose(['logs', '--no-color'], { allowFailure: true });
  if (logs.stdout) console.error(logs.stdout);
  if (logs.stderr) console.error(logs.stderr);
} finally {
  const cleanup = runCompose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    { allowFailure: true },
  );
  if (cleanup.status !== 0 && !loadTestError) {
    loadTestError = new Error(`Compose cleanup failed\n${cleanup.stderr}`);
  }
}

if (loadTestError) throw loadTestError;
