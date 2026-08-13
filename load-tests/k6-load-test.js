/* global __ENV */

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const environment = __ENV;
const phase = requiredEnvironment('TEST_PHASE');
const baseUrl = requiredEnvironment('BASE_URL');
const runId = requiredEnvironment('RUN_ID');
const datasetEndMs = positiveIntegerEnvironment('DATASET_END_MS');
const totalLogs = positiveIntegerEnvironment('TOTAL_LOGS');
const seedLogs = nonNegativeIntegerEnvironment('SEED_LOGS');
const mixedLogs = positiveIntegerEnvironment('MIXED_LOGS');
const batchSize = positiveIntegerEnvironment('BATCH_SIZE');
const mixedBatchRate = positiveIntegerEnvironment('MIXED_BATCH_RATE');
const mixedDurationSeconds = positiveIntegerEnvironment(
  'MIXED_DURATION_SECONDS',
);
const aggregationWindowHours = positiveIntegerEnvironment(
  'AGGREGATION_WINDOW_HOURS',
);
const seedVus = positiveIntegerEnvironment('SEED_VUS');
const maximumIngestionVus = positiveIntegerEnvironment('MAXIMUM_INGESTION_VUS');
const summaryPath = requiredEnvironment('SUMMARY_PATH');

const monthMs = 30 * 24 * 60 * 60 * 1_000;
const datasetStartMs = datasetEndMs - monthMs;
const levels = ['debug', 'info', 'warn', 'error'];
const regions = ['west', 'east', 'central'];
const services = Array.from({ length: 12 }, (_, index) => `load-api-${index}`);

if (phase !== 'seed' && phase !== 'mixed') {
  throw new Error('TEST_PHASE must be seed or mixed');
}
if (seedLogs % batchSize !== 0 || mixedLogs % batchSize !== 0) {
  throw new Error('SEED_LOGS and mixed logs must be divisible by BATCH_SIZE');
}
if (mixedBatchRate * mixedDurationSeconds * batchSize !== mixedLogs) {
  throw new Error(
    'MIXED_BATCH_RATE * MIXED_DURATION_SECONDS * BATCH_SIZE must equal mixed logs',
  );
}

const acceptedLogs = new Counter('accepted_logs');
const ingestionLatency = new Trend('ingestion_latency_ms', true);
const ingestionSuccess = new Rate('ingestion_success');
const queryLatency = new Trend('query_latency_ms', true);
const querySuccess = new Rate('query_success');
const aggregationLatency = new Trend('aggregation_latency_ms', true);
const aggregationSuccess = new Rate('aggregation_success');
const visibilityLag = new Trend('visibility_lag_ms', true);
const visibilitySuccess = new Rate('visibility_success');

const commonThresholds = {
  ingestion_success: ['rate==1'],
  dropped_iterations: ['count==0'],
};

const seedOptions = {
  discardResponseBodies: false,
  scenarios: {
    seed_ingestion: {
      executor: 'shared-iterations',
      exec: 'seedIngestion',
      vus: seedVus,
      iterations: seedLogs / batchSize,
      maxDuration: '30m',
      gracefulStop: '1m',
    },
  },
  thresholds: commonThresholds,
};

const mixedOptions = {
  discardResponseBodies: false,
  scenarios: {
    mixed_ingestion: {
      executor: 'constant-arrival-rate',
      exec: 'mixedIngestion',
      rate: mixedBatchRate,
      timeUnit: '1s',
      duration: `${mixedDurationSeconds}s`,
      preAllocatedVUs: Math.min(mixedBatchRate, maximumIngestionVus),
      maxVUs: maximumIngestionVus,
      gracefulStop: '1m',
    },
    filtered_queries: {
      executor: 'constant-arrival-rate',
      exec: 'filteredQuery',
      rate: 10,
      timeUnit: '1s',
      duration: `${mixedDurationSeconds}s`,
      preAllocatedVUs: 4,
      maxVUs: 20,
      gracefulStop: '30s',
    },
    aggregations: {
      executor: 'constant-arrival-rate',
      exec: 'aggregate',
      rate: 1,
      timeUnit: '1s',
      duration: `${mixedDurationSeconds}s`,
      preAllocatedVUs: 2,
      maxVUs: 10,
      gracefulStop: '30s',
    },
    visibility_probes: {
      executor: 'constant-arrival-rate',
      exec: 'visibilityProbe',
      rate: 1,
      timeUnit: '5s',
      duration: `${mixedDurationSeconds}s`,
      preAllocatedVUs: 1,
      maxVUs: 4,
      gracefulStop: '30s',
    },
  },
  thresholds: {
    ...commonThresholds,
    query_success: ['rate==1'],
    aggregation_success: ['rate==1'],
    visibility_success: ['rate==1'],
  },
};

export const options = phase === 'seed' ? seedOptions : mixedOptions;

function requiredEnvironment(name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name) {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerEnvironment(name) {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function timestampForSequence(sequence) {
  if (totalLogs === 1) return new Date(datasetEndMs).toISOString();
  const offset = Math.floor((sequence * monthMs) / (totalLogs - 1));
  return new Date(datasetStartMs + offset).toISOString();
}

function logEntry(sequence, entryRunId = runId) {
  const serviceIndex = sequence % services.length;
  return {
    timestamp: timestampForSequence(sequence % totalLogs),
    service: services[serviceIndex],
    level: levels[sequence % levels.length],
    message: `load-test event ${sequence} from service ${serviceIndex}`,
    attributes: {
      run_id: entryRunId,
      region: regions[sequence % regions.length],
      host: `host-${sequence % 100}`,
      sequence,
      cached: sequence % 2 === 0,
    },
  };
}

function postBatch(
  firstSequence,
  size,
  entryRunId = runId,
  recordAcceptedLogs = true,
) {
  const logs = Array.from({ length: size }, (_, index) =>
    logEntry(firstSequence + index, entryRunId),
  );
  const response = http.post(`${baseUrl}/logs`, JSON.stringify({ logs }), {
    headers: { 'content-type': 'application/json' },
    tags: { operation: 'ingest', phase },
    timeout: '60s',
  });
  ingestionLatency.add(response.timings.duration);

  let body;
  try {
    body = response.json();
  } catch {
    body = undefined;
  }
  const succeeded = check(response, {
    'ingestion returns HTTP 200': (result) => result.status === 200,
    'ingestion accepts the complete batch': () => body?.accepted === size,
    'ingestion rejects no entries': () =>
      Array.isArray(body?.rejected) && body.rejected.length === 0,
  });
  ingestionSuccess.add(succeeded);
  if (succeeded && recordAcceptedLogs) acceptedLogs.add(size);
}

function queryString(parameters) {
  return Object.entries(parameters)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');
}

export function seedIngestion() {
  postBatch(exec.scenario.iterationInTest * batchSize, batchSize);
}

export function mixedIngestion() {
  postBatch(seedLogs + exec.scenario.iterationInTest * batchSize, batchSize);
}

export function filteredQuery() {
  const service = services[exec.scenario.iterationInTest % services.length];
  const parameters = queryString({
    service,
    since: new Date(datasetStartMs).toISOString(),
    until: new Date(datasetEndMs + 1).toISOString(),
    'attr.run_id': runId,
    limit: '100',
  });
  const response = http.get(`${baseUrl}/logs?${parameters}`, {
    tags: { operation: 'query' },
    timeout: '30s',
  });
  queryLatency.add(response.timings.duration);
  const succeeded = check(response, {
    'query returns HTTP 200': (result) => result.status === 200,
    'query returns logs': (result) => Array.isArray(result.json('logs')),
  });
  querySuccess.add(succeeded);
}

export function aggregate() {
  const parameters = queryString({
    since: new Date(
      datasetEndMs - aggregationWindowHours * 60 * 60 * 1_000,
    ).toISOString(),
    until: new Date(datasetEndMs + 1).toISOString(),
    bucket: '1h',
    group_by: 'service',
    'attr.run_id': runId,
  });
  const response = http.get(`${baseUrl}/logs/aggregate?${parameters}`, {
    tags: { operation: 'aggregate' },
    timeout: '30s',
  });
  aggregationLatency.add(response.timings.duration);
  const succeeded = check(response, {
    'aggregation returns HTTP 200': (result) => result.status === 200,
    'aggregation returns buckets': (result) =>
      Array.isArray(result.json('buckets')),
  });
  aggregationSuccess.add(succeeded);
}

export function visibilityProbe() {
  const probeNumber = exec.scenario.iterationInTest;
  const probeId = `${runId}-${probeNumber}`;
  const probeRunId = `${runId}-probe`;
  const sequence = totalLogs - 1 - (probeNumber % totalLogs);
  const startedAt = Date.now();
  postBatch(sequence, 1, probeRunId, false);

  const parameters = queryString({
    'attr.run_id': probeRunId,
    'attr.sequence': String(sequence),
    limit: '1',
  });
  let visible = false;
  while (Date.now() - startedAt < 20_000) {
    const response = http.get(`${baseUrl}/logs?${parameters}`, {
      tags: { operation: 'visibility' },
      timeout: '5s',
    });
    if (response.status === 200 && response.json('logs.0') !== undefined) {
      visible = true;
      break;
    }
    sleep(0.25);
  }

  const elapsed = Date.now() - startedAt;
  visibilityLag.add(elapsed);
  visibilitySuccess.add(
    check(visible, {
      [`probe ${probeId} is visible within 20 seconds`]: Boolean,
    }),
  );
}

export function handleSummary(data) {
  return {
    [summaryPath]: JSON.stringify(data, undefined, 2),
  };
}
