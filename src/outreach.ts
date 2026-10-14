import { newId } from './contracts.js';
import type { AgentAmpDb } from './db.js';
import { writeReceipt } from './receipts.js';
import { artifactPath, rootDir, type Environment } from './paths.js';
import { assertSendAllowed } from './safety.js';
import { relative } from 'node:path';
import { writeFileSync } from 'node:fs';

export interface ProspectEvidence {
  prospectId: string;
  firstName?: string;
  agencyName: string;
  website: string;
  recipient: string;
  observation: string;
  exampleBrand: string;
  proofSummary: string;
}

export interface OutreachDraft {
  author: 'amp-drafter';
  recipient: string;
  subject: string;
  body: string;
  evidence: ProspectEvidence;
}

export interface OutreachReview {
  reviewer: 'amp-reviewer';
  approved: boolean;
  issues: string[];
  reviewedAt: string;
}

const forbidden = [
  /guarantee(?:d|s)?\s+(?:revenue|sales|conversion)/i,
  /will\s+(?:increase|double|triple)\s+(?:revenue|sales|conversion)/i,
  /real\s+revenue/i,
  /live\s+shopify\s+oauth/i,
  /we(?:'ll| will)\s+(?:edit|change)\s+your\s+(?:live\s+)?store/i,
];

export function draftOutreach(evidence: ProspectEvidence): OutreachDraft {
  const greeting = evidence.firstName?.trim() ? `Hi ${evidence.firstName.trim()} —` : 'Hi —';
  return {
    author: 'amp-drafter',
    recipient: evidence.recipient,
    subject: `A co-branded AI-shopping audit for ${evidence.agencyName}`,
    body: `${greeting} I noticed ${evidence.observation}\n\nWe tested how AI shopping agents interpret product catalogs like ${evidence.exampleBrand}. ${evidence.proofSummary}\n\nAgentAmp can run the audit and prepare the fixes behind the scenes while your agency keeps the client relationship. We can share an example catalog audit and discuss whether the workflow fits your team.\n\nWorth seeing the short example?\n\n— AgentAmp\n\nIf this is not relevant, reply “no” and I will not follow up.`,
    evidence,
  };
}

export function reviewOutreach(draft: OutreachDraft): OutreachReview {
  const issues: string[] = [];
  for (const rule of forbidden) if (rule.test(draft.body)) issues.push(`unsupported claim: ${String(rule)}`);
  if (!draft.body.includes(draft.evidence.observation)) issues.push('personalization evidence missing');
  if (!draft.body.toLowerCase().includes('reply “no”')) issues.push('opt-out language missing');
  if (draft.body.length > 1_200) issues.push('message exceeds 1200 characters');
  if (!draft.body.toLowerCase().includes('tested')) issues.push('proof framing missing');
  return { reviewer: 'amp-reviewer', approved: issues.length === 0, issues, reviewedAt: new Date().toISOString() };
}

export function sendReviewedDraft(input: {
  db: AgentAmpDb;
  environment: Environment;
  jobId: string;
  idempotencyKey: string;
  draft: OutreachDraft;
  review: OutreachReview;
}): { sendId: string; artifactPath: string; receiptPath: string; duplicate: boolean } {
  if (!input.review.approved || input.review.reviewer !== 'amp-reviewer') throw new Error('review-required');
  assertSendAllowed(input.db, input.environment, input.draft.recipient);
  const existing = input.db.prepare('SELECT id, provider_response_json FROM sends WHERE idempotency_key = ?').get(input.idempotencyKey) as { id: string; provider_response_json: string } | undefined;
  if (existing) {
    const provider = JSON.parse(existing.provider_response_json) as { artifactPath?: string; receiptPath?: string };
    return {
      sendId: existing.id,
      artifactPath: provider.artifactPath ?? '',
      receiptPath: provider.receiptPath ?? '',
      duplicate: true,
    };
  }
  if (input.environment === 'prod') throw new Error('production-provider-disarmed: provider adapter is not armed');

  const sendId = newId('send');
  const now = new Date().toISOString();
  input.db.prepare(`
    INSERT INTO sends (id, job_id, prospect_id, recipient, subject, body, provider, status, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'file-sink', 'attempting', ?, ?)
  `).run(sendId, input.jobId, input.draft.evidence.prospectId, input.draft.recipient, input.draft.subject, input.draft.body, input.idempotencyKey, now);

  const outbox = input.environment === 'dev' ? 'state/outbox-dev' : 'state/outbox-staging';
  const mailPath = artifactPath(outbox, `${sendId}.eml`);
  writeFileSync(mailPath, `To: ${input.draft.recipient}\nSubject: ${input.draft.subject}\nX-AgentAmp-Mode: ${input.environment}\n\n${input.draft.body}\n`, 'utf8');
  const receiptPath = writeReceipt(input.db, {
    actor: 'amp-mailer',
    sop: 'fleet/amp-mailer/sops/send-reviewed-message.md',
    mode: 'setup',
    outcome: 'success',
    inputs: { jobId: input.jobId, recipient: input.draft.recipient, provider: 'file-sink' },
    artifacts: [{ type: 'email-file', path: mailPath }],
    notes: 'Reviewed outreach was written to the staging file sink. No external message was sent.',
  });
  const providerResponse = JSON.stringify({ artifactPath: mailPath, receiptPath });
  input.db.prepare(`UPDATE sends SET status = 'sent', sent_at = ?, provider_response_json = ? WHERE id = ?`)
    .run(now, providerResponse, sendId);
  return { sendId, artifactPath: relative(rootDir(), mailPath), receiptPath: relative(rootDir(), receiptPath), duplicate: false };
}
