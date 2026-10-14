import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { auditResultSchema, hashValue, newId, type AuditResult, type JobEnvelope } from './contracts.js';
import { completeJob, enqueueJob, openDatabase, statusSnapshot, type AgentAmpDb } from './db.js';
import { createCheckout } from './billing.js';
import { lintCatalog } from './feed.js';
import { draftOutreach, reviewOutreach, sendReviewedDraft, type ProspectEvidence } from './outreach.js';
import { artifactPath, rootDir, type Environment } from './paths.js';
import { writeReceipt } from './receipts.js';
import { renderAuditReport } from './report.js';
import { assertNotKilled } from './safety.js';
import { runSeededSimulation } from './simulator.js';

export interface DemoResult {
  environment: Environment;
  externalMessagesSent: 0;
  moneyMovedCents: 0;
  outreachArtifact: string;
  auditArtifact: string;
  reportArtifact: string;
  checkoutArtifact: string;
  simulationIncluded: boolean;
  finalReceipt: string;
  counts: Record<string, number>;
}

function seedDemoEntities(db: AgentAmpDb, marginFloorBps: number): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO agencies (id, name, website, status, branding_json, created_at)
    VALUES ('agency_demo_synthetic', 'Synthetic Agency', 'https://agency.example.invalid', 'demo', ?, ?)
  `).run(JSON.stringify({ coBrand: 'Synthetic Agency x AgentAmp' }), now);
  db.prepare(`
    INSERT OR IGNORE INTO stores (id, agency_id, name, domain, margin_floor_bps, status, created_at)
    VALUES ('store_demo_synthetic', 'agency_demo_synthetic', 'Synthetic Store', 'store.example.invalid', ?, 'demo', ?)
  `).run(marginFloorBps, now);
  db.prepare(`
    INSERT OR IGNORE INTO prospects (id, name, website, contact_email, evidence_json, status, created_at)
    VALUES ('prospect_demo_synthetic', 'Synthetic Agency', 'https://agency.example.invalid', 'demo@example.invalid', ?, 'qualified-demo', ?)
  `).run(JSON.stringify({ observation: 'Synthetic sample evidence for demonstration only.' }), now);
  db.prepare(`
    INSERT OR IGNORE INTO campaigns (id, name, status, daily_cap, weekly_cap, created_at)
    VALUES ('campaign_synthetic_demo', 'Synthetic Demo Campaign', 'staging', 0, 0, ?)
  `).run(now);
}

function job(input: Pick<JobEnvelope, 'stage' | 'actor' | 'environment' | 'entityRefs' | 'idempotencyKey'>): JobEnvelope {
  return {
    envelope: 'amp.job.v1',
    jobId: newId('job'),
    product: 'agentamp',
    environment: input.environment,
    stage: input.stage,
    actor: input.actor,
    entityRefs: input.entityRefs,
    inputRefs: [],
    idempotencyKey: input.idempotencyKey,
    gate: 'none',
    capsSnapshot: {},
    attempts: 0,
    maxAttempts: 3,
    deadline: null,
    status: 'queued',
    resultRef: null,
    receiptRef: null,
  };
}

export async function runDemo(environment: Environment, reset: boolean): Promise<DemoResult> {
  if (environment === 'prod') throw new Error('demo-refuses-production');
  assertNotKilled('product');
  assertNotKilled('amp-dispatch');
  const db = openDatabase(environment, { reset });
  const offer = JSON.parse(readFileSync(resolve(rootDir(), 'config/offer.json'), 'utf8')) as { marginFloorBps: number };
  try {
    seedDemoEntities(db, offer.marginFloorBps);

    const evidence: ProspectEvidence = {
      prospectId: 'prospect_demo_synthetic',
      agencyName: 'Synthetic Agency',
      website: 'https://agency.example.invalid',
      recipient: 'demo@example.invalid',
      observation: 'Synthetic sample evidence for demonstration only.',
      exampleBrand: 'Synthetic Brand',
      proofSummary: 'Synthetic proof text; no real evidence or customer data.',
    };
    const outreachJobResult = enqueueJob(db, job({
      environment,
      stage: 'gtm.outreach',
      actor: 'amp-drafter',
      entityRefs: { prospectId: evidence.prospectId, campaignId: 'campaign_synthetic_demo' },
      idempotencyKey: `${environment}:demo:outreach:v1`,
    }));
    const draft = draftOutreach(evidence);
    const review = reviewOutreach(draft);
    const send = sendReviewedDraft({
      db,
      environment,
      jobId: outreachJobResult.job.jobId,
      idempotencyKey: `${environment}:demo:send:v1`,
      draft,
      review,
    });
    completeJob(db, outreachJobResult.job.jobId, 'done', send.artifactPath, send.receiptPath);

    const auditJobResult = enqueueJob(db, job({
      environment,
      stage: 'fulfil.audit',
      actor: 'amp-analyst',
      entityRefs: { agencyId: 'agency_demo_synthetic', storeId: 'store_demo_synthetic' },
      idempotencyKey: `${environment}:demo:audit:v1`,
    }));
    const catalogPath = resolve(rootDir(), 'fixtures/demo-catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown[];
    const feed = lintCatalog(catalog, offer.marginFloorBps);
    const simulation = await runSeededSimulation(environment, { agents: 40, seed: 42 });
    const audit: AuditResult = auditResultSchema.parse({
      contract: 'audit.v1',
      auditId: `audit_demo_${feed.inputHash.slice(0, 12)}`,
      agencyId: 'agency_demo_synthetic',
      storeId: 'store_demo_synthetic',
      generatedAt: new Date().toISOString(),
      inputHash: feed.inputHash,
      score: feed.score,
      productsChecked: feed.products.length,
      findings: feed.findings,
      simulation: simulation.simulation,
      simulationUnavailableReason: simulation.unavailableReason,
    });
    const auditPath = artifactPath('clients', 'synthetic-agency', 'synthetic-store', `${audit.auditId}.json`);
    writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf8');
    db.prepare(`
      INSERT OR IGNORE INTO audits (id, store_id, contract_version, input_hash, status, result_path, created_at)
      VALUES (?, 'store_demo_synthetic', 'audit.v1', ?, 'complete', ?, ?)
    `).run(audit.auditId, audit.inputHash, relative(rootDir(), auditPath), audit.generatedAt);
    const reportPath = renderAuditReport({
      audit,
      agencyName: 'Synthetic Agency',
      storeName: 'Synthetic Store',
      coBrand: 'Synthetic Agency x AgentAmp',
    });
    const auditReceipt = writeReceipt(db, {
      actor: 'amp-analyst',
      sop: 'fleet/workers/amp-analyst.md',
      mode: 'setup',
      outcome: simulation.simulation ? 'success' : 'partial',
      inputs: { storeId: 'store_demo_synthetic', inputHash: feed.inputHash, products: feed.products.length },
      artifacts: [{ type: 'audit-json', path: auditPath }, { type: 'co-branded-report', path: reportPath }],
      notes: simulation.simulation
        ? 'Catalog lint, seeded engine verification, and co-branded report completed. No live store was changed.'
        : `Catalog lint and report completed without simulation: ${simulation.unavailableReason ?? 'unavailable'}`,
    });
    completeJob(db, auditJobResult.job.jobId, 'done', relative(rootDir(), reportPath), relative(rootDir(), auditReceipt));

    const billingJobResult = enqueueJob(db, job({
      environment,
      stage: 'bill.checkout',
      actor: 'svc-billing',
      entityRefs: { agencyId: 'agency_demo_synthetic', storeId: 'store_demo_synthetic' },
      idempotencyKey: `${environment}:demo:billing-job:v1`,
    }));
    const checkout = await createCheckout({
      db,
      environment,
      storeId: 'store_demo_synthetic',
      agencyEmail: evidence.recipient,
      idempotencyKey: `${environment}:demo:checkout:v1`,
    });
    const billingReceipt = writeReceipt(db, {
      actor: 'svc-billing',
      sop: 'fleet/amp-dispatch/sops/run-staging-loop.md',
      mode: 'setup',
      outcome: 'success',
      inputs: { storeId: 'store_demo_synthetic', environment, autoCharge: false },
      artifacts: [{ type: 'checkout-draft', path: resolve(rootDir(), checkout.artifactPath) }],
      notes: 'A staging checkout description was prepared. No Stripe request was made and no money moved.',
    });
    completeJob(db, billingJobResult.job.jobId, 'done', checkout.artifactPath, relative(rootDir(), billingReceipt));

    const finalReceipt = writeReceipt(db, {
      actor: 'amp-dispatch',
      sop: 'fleet/amp-dispatch/sops/run-staging-loop.md',
      mode: 'setup',
      outcome: 'success',
      inputs: { environment, runHash: hashValue({ environment, auditId: audit.auditId, sendId: send.sendId }) },
      artifacts: [
        { type: 'staging-email', path: resolve(rootDir(), send.artifactPath) },
        { type: 'audit-json', path: auditPath },
        { type: 'report-html', path: reportPath },
        { type: 'checkout-draft', path: resolve(rootDir(), checkout.artifactPath) },
      ],
      notes: 'The bounded staging loop completed end to end. External messages sent: 0. Money moved: $0.00.',
    });

    return {
      environment,
      externalMessagesSent: 0,
      moneyMovedCents: 0,
      outreachArtifact: send.artifactPath,
      auditArtifact: relative(rootDir(), auditPath),
      reportArtifact: relative(rootDir(), reportPath),
      checkoutArtifact: checkout.artifactPath,
      simulationIncluded: Boolean(audit.simulation),
      finalReceipt: relative(rootDir(), finalReceipt),
      counts: statusSnapshot(db),
    };
  } finally {
    db.close();
  }
}
