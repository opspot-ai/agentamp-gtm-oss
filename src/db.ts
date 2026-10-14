import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { JobEnvelope } from './contracts.js';
import { jobEnvelopeSchema } from './contracts.js';
import { databasePath, ensureLayout, type Environment } from './paths.js';

export type AgentAmpDb = DatabaseSync;

const migration = `
CREATE TABLE IF NOT EXISTS agencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT NOT NULL,
  free_store_credits INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'prospect',
  branding_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL REFERENCES agencies(id),
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  margin_floor_bps INTEGER,
  status TEXT NOT NULL DEFAULT 'intake',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'qualified',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS prospects_email_unique_idx ON prospects(contact_email);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  daily_cap INTEGER NOT NULL,
  weekly_cap INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  envelope TEXT NOT NULL,
  product TEXT NOT NULL,
  environment TEXT NOT NULL,
  stage TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_refs_json TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  gate_name TEXT NOT NULL,
  caps_snapshot_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  deadline TEXT,
  status TEXT NOT NULL,
  result_ref TEXT,
  receipt_ref TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status_stage_idx ON jobs(status, stage);
CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  prospect_id TEXT REFERENCES prospects(id),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS sends_sent_at_idx ON sends(sent_at);
CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  send_id TEXT NOT NULL REFERENCES sends(id),
  classification TEXT NOT NULL,
  body TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT,
  UNIQUE(provider, external_id)
);
CREATE INDEX IF NOT EXISTS provider_events_status_idx ON provider_events(status, provider);
CREATE TABLE IF NOT EXISTS provider_links (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  internal_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(provider, entity_type, external_id),
  UNIQUE(provider, entity_type, internal_id)
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  prospect_id TEXT REFERENCES prospects(id),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  start_at TEXT,
  status TEXT NOT NULL,
  booking_url TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, external_id)
);
CREATE TABLE IF NOT EXISTS suppression (
  email TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  contract_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result_path TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(store_id, input_hash)
);
CREATE TABLE IF NOT EXISTS billing (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  setup_cents INTEGER NOT NULL,
  recurring_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  checkout_url TEXT,
  provider_ref TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts_index (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  outcome TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(environment: Environment, options: { reset?: boolean } = {}): AgentAmpDb {
  ensureLayout();
  const path = databasePath(environment);
  if (options.reset && existsSync(path)) {
    rmSync(path);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    }
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(migration);
  return db;
}

export function enqueueJob(db: AgentAmpDb, envelope: JobEnvelope): { created: boolean; job: JobEnvelope } {
  const parsed = jobEnvelopeSchema.parse(envelope);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT OR IGNORE INTO jobs (
      job_id, envelope, product, environment, stage, actor, entity_refs_json,
      input_refs_json, idempotency_key, gate_name, caps_snapshot_json, attempts,
      max_attempts, deadline, status, result_ref, receipt_ref, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parsed.jobId,
    parsed.envelope,
    parsed.product,
    parsed.environment,
    parsed.stage,
    parsed.actor,
    JSON.stringify(parsed.entityRefs),
    JSON.stringify(parsed.inputRefs),
    parsed.idempotencyKey,
    parsed.gate,
    JSON.stringify(parsed.capsSnapshot),
    parsed.attempts,
    parsed.maxAttempts,
    parsed.deadline,
    parsed.status,
    parsed.resultRef,
    parsed.receiptRef,
    now,
    now,
  );
  if (result.changes === 1) return { created: true, job: parsed };
  const existing = db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(parsed.idempotencyKey) as Record<string, unknown>;
  return { created: false, job: rowToJob(existing) };
}

export function completeJob(
  db: AgentAmpDb,
  jobId: string,
  status: 'done' | 'blocked' | 'failed' | 'killed',
  resultRef: string | null,
  receiptRef: string | null,
  error: string | null = null,
): void {
  db.prepare(`
    UPDATE jobs
    SET status = ?, result_ref = ?, receipt_ref = ?, error = ?, updated_at = ?
    WHERE job_id = ?
  `).run(status, resultRef, receiptRef, error, new Date().toISOString(), jobId);
}

export function retryJob(db: AgentAmpDb, jobId: string, error: string): void {
  db.prepare(`
    UPDATE jobs
    SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        error = ?, updated_at = ?
    WHERE job_id = ?
  `).run(error, new Date().toISOString(), jobId);
}

export function countRows(db: AgentAmpDb, table: string): number {
  const allowed = new Set(['agencies', 'stores', 'prospects', 'campaigns', 'jobs', 'sends', 'replies', 'suppression', 'audits', 'billing', 'receipts_index', 'provider_events', 'provider_links', 'meetings']);
  if (!allowed.has(table)) throw new Error(`Unsupported table ${table}`);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

export function statusSnapshot(db: AgentAmpDb): Record<string, number> {
  return Object.fromEntries(
    ['agencies', 'stores', 'prospects', 'campaigns', 'jobs', 'sends', 'replies', 'suppression', 'audits', 'billing', 'receipts_index', 'provider_events', 'provider_links', 'meetings']
      .map((table) => [table, countRows(db, table)]),
  );
}

export function claimQueuedJobs(db: AgentAmpDb, stage: JobEnvelope['stage'], limit: number): JobEnvelope[] {
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'queued' AND stage = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(stage, limit) as Array<Record<string, unknown>>;
    const now = new Date().toISOString();
    for (const row of rows) {
      db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND status = 'queued'`)
        .run(now, String(row['job_id']));
    }
    db.exec('COMMIT');
    return rows.map((row) => rowToJob({ ...row, status: 'running', attempts: Number(row['attempts']) + 1 }));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rowToJob(row: Record<string, unknown>): JobEnvelope {
  return jobEnvelopeSchema.parse({
    envelope: row['envelope'],
    jobId: row['job_id'],
    product: row['product'],
    environment: row['environment'],
    stage: row['stage'],
    actor: row['actor'],
    entityRefs: JSON.parse(String(row['entity_refs_json'])),
    inputRefs: JSON.parse(String(row['input_refs_json'])),
    idempotencyKey: row['idempotency_key'],
    gate: row['gate_name'],
    capsSnapshot: JSON.parse(String(row['caps_snapshot_json'])),
    attempts: row['attempts'],
    maxAttempts: row['max_attempts'],
    deadline: row['deadline'],
    status: row['status'],
    resultRef: row['result_ref'],
    receiptRef: row['receipt_ref'],
  });
}
