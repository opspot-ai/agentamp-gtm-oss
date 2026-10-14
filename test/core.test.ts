import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCheckout } from '../src/billing.js';
import { newId, type JobEnvelope } from '../src/contracts.js';
import { enqueueJob, openDatabase, type AgentAmpDb } from '../src/db.js';
import { lintCatalog } from '../src/feed.js';
import { draftOutreach, reviewOutreach, sendReviewedDraft, type ProspectEvidence } from '../src/outreach.js';
import { rootDir } from '../src/paths.js';
import { addSuppression } from '../src/safety.js';

let db: AgentAmpDb;

beforeEach(() => {
  rmSync(rootDir(), { recursive: true, force: true });
  mkdirSync(resolve(rootDir(), 'config'), { recursive: true });
  writeFileSync(resolve(rootDir(), 'config/offer.json'), JSON.stringify({ setupCents: 0, monthlyPerStoreCents: 0 }));
  db = openDatabase('staging', { reset: true });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agencies (id, name, website, created_at) VALUES ('synthetic-agency-001', 'Synthetic Agency', 'https://example.invalid', ?)`).run(now);
  db.prepare(`INSERT INTO stores (id, agency_id, name, domain, created_at) VALUES ('synthetic-store-001', 'synthetic-agency-001', 'Synthetic Store', 'store.example.invalid', ?)`).run(now);
  db.prepare(`INSERT INTO prospects (id, name, website, contact_email, evidence_json, created_at) VALUES ('synthetic-prospect-001', 'Synthetic Agency', 'https://example.invalid', 'synthetic@example.invalid', '{}', ?)`).run(now);
});

afterEach(() => db.close());

function demoJob(idempotencyKey: string): JobEnvelope {
  return {
    envelope: 'amp.job.v1', jobId: newId('job'), product: 'agentamp', environment: 'staging',
    stage: 'gtm.outreach', actor: 'amp-drafter', entityRefs: {}, inputRefs: [], idempotencyKey,
    gate: 'none', capsSnapshot: {}, attempts: 0, maxAttempts: 3, deadline: null, status: 'queued', resultRef: null, receiptRef: null,
  };
}

const evidence: ProspectEvidence = {
  prospectId: 'synthetic-prospect-001', agencyName: 'Synthetic Agency', website: 'https://example.invalid', recipient: 'synthetic@example.invalid',
  observation: 'your team publishes clear CRO teardowns', exampleBrand: 'Synthetic Store', proofSummary: 'The sample found concrete catalog gaps.',
};

describe('bounded operations', () => {
  it('deduplicates queued jobs', () => {
    expect(enqueueJob(db, demoJob('same-job-key')).created).toBe(true);
    expect(enqueueJob(db, demoJob('same-job-key')).created).toBe(false);
  });

  it('requires independent review and respects suppression', () => {
    const draft = draftOutreach(evidence);
    const review = reviewOutreach(draft);
    expect(review.approved).toBe(true);
    addSuppression(db, evidence.recipient, 'test', 'opt-out');
    expect(() => sendReviewedDraft({ db, environment: 'staging', jobId: enqueueJob(db, demoJob('job-2-key')).job.jobId, idempotencyKey: 'send-key-123', draft, review }))
      .toThrow(/suppressed/);
  });

  it('finds catalog problems deterministically', () => {
    const result = lintCatalog([{
      externalId: '1', title: 'Synthetic Demo Product', description: 'Short', brand: '', category: '', imageUrl: '', sku: '',
      priceCents: 1000, costCents: 800, inventoryQty: 0, tags: [],
    }], 10_000);
    expect(result.score).toBeLessThan(50);
    expect(result.findings.map((item) => item.code)).toContain('margin-below-floor');
  });

  it('creates only a file-backed checkout in staging', async () => {
    const result = await createCheckout({ db, environment: 'staging', storeId: 'synthetic-store-001', agencyEmail: 'synthetic@example.invalid', idempotencyKey: 'checkout-key-123' });
    expect(result.status).toBe('draft');
    expect(result.checkoutUrl).toMatch(/^file:/);
    expect(resolve(rootDir(), result.artifactPath)).toContain(rootDir());
  });
});
