import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { claimQueuedJobs, completeJob, retryJob, type AgentAmpDb } from './db.js';
import { draftOutreach, reviewOutreach, sendReviewedDraft, type ProspectEvidence } from './outreach.js';
import { artifactPath, rootDir, type Environment } from './paths.js';
import { writeReceipt } from './receipts.js';
import { assertNotKilled } from './safety.js';
import { loadProvidersConfig, queueApprovedSmartleadLead, sendSmartleadBookingReply } from './smartlead.js';

interface DispatchResult {
  claimed: number;
  done: number;
  blocked: number;
  retried: number;
  artifacts: string[];
}

interface ProspectRow {
  id: string;
  name: string;
  website: string;
  contact_email: string;
  evidence_json: string;
}

function prospectEvidence(row: ProspectRow): ProspectEvidence {
  const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
  const firstName = typeof evidence['firstName'] === 'string' ? evidence['firstName'] : undefined;
  return {
    prospectId: row.id,
    ...(firstName ? { firstName } : {}),
    agencyName: row.name,
    website: row.website,
    recipient: row.contact_email,
    observation: String(evidence['observation'] ?? ''),
    exampleBrand: String(evidence['exampleBrand'] ?? 'a representative ecommerce catalog'),
    proofSummary: String(evidence['proofSummary'] ?? 'The example audit identifies catalog gaps without touching a live store.'),
  };
}

function isGateError(message: string): boolean {
  return /(disarmed|suppressed|killswitch|outside-send-window|daily-cap|weekly-cap|review-required|email-stats-id-missing)/i.test(message);
}

export async function processOutreachQueue(input: { db: AgentAmpDb; environment: Environment; limit: number }): Promise<DispatchResult> {
  assertNotKilled('amp-dispatch');
  const jobs = claimQueuedJobs(input.db, 'gtm.outreach', input.limit);
  const result: DispatchResult = { claimed: jobs.length, done: 0, blocked: 0, retried: 0, artifacts: [] };
  for (const job of jobs) {
    try {
      const prospectId = job.entityRefs['prospectId'];
      if (!prospectId) throw new Error('prospect-id-missing');
      const row = input.db.prepare(`
        SELECT id, name, website, contact_email, evidence_json FROM prospects WHERE id = ? AND status = 'qualified'
      `).get(prospectId) as ProspectRow | undefined;
      if (!row) throw new Error('qualified-prospect-missing');
      const evidence = prospectEvidence(row);
      const draft = draftOutreach(evidence);
      const review = reviewOutreach(draft);
      if (!review.approved) throw new Error(`review-required: ${review.issues.join('; ')}`);
      const idempotencyKey = `${input.environment}:${job.jobId}:send`;
      const delivery = input.environment === 'prod'
        ? await queueApprovedSmartleadLead({ db: input.db, environment: input.environment, jobId: job.jobId, idempotencyKey, draft, review })
        : sendReviewedDraft({ db: input.db, environment: input.environment, jobId: job.jobId, idempotencyKey, draft, review });
      completeJob(input.db, job.jobId, 'done', delivery.sendId, delivery.receiptPath);
      result.done += 1;
      result.artifacts.push(delivery.receiptPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isGateError(message)) {
        completeJob(input.db, job.jobId, 'blocked', null, null, message);
        result.blocked += 1;
      } else {
        retryJob(input.db, job.jobId, message);
        result.retried += 1;
      }
    }
  }
  return result;
}

export async function processBookingQueue(input: { db: AgentAmpDb; environment: Environment; limit: number }): Promise<DispatchResult> {
  assertNotKilled('amp-dispatch');
  const jobs = claimQueuedJobs(input.db, 'gtm.book', input.limit);
  const result: DispatchResult = { claimed: jobs.length, done: 0, blocked: 0, retried: 0, artifacts: [] };
  for (const job of jobs) {
    try {
      const prospectId = job.entityRefs['prospectId'];
      if (!prospectId) throw new Error('prospect-id-missing');
      const row = input.db.prepare(`SELECT id, name, website, contact_email, evidence_json FROM prospects WHERE id = ?`).get(prospectId) as ProspectRow | undefined;
      if (!row) throw new Error('prospect-missing');
      const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
      let output: { sendId: string; receiptPath: string };
      if (input.environment === 'prod') {
        const emailStatsId = job.entityRefs['emailStatsId'];
        const campaignId = job.entityRefs['campaignId'];
        const leadId = job.entityRefs['leadId'];
        if (!campaignId || !leadId) throw new Error('email-stats-id-missing: provider did not identify the campaign lead');
        const firstName = typeof evidence['firstName'] === 'string' ? evidence['firstName'] : undefined;
        output = await sendSmartleadBookingReply({
          db: input.db,
          environment: input.environment,
          jobId: job.jobId,
          prospectId,
          ...(emailStatsId ? { emailStatsId } : {}),
          campaignId,
          leadId,
          recipient: row.contact_email,
          ...(firstName ? { firstName } : {}),
          idempotencyKey: `${input.environment}:${job.jobId}:booking-reply`,
        });
      } else {
        const path = artifactPath('state', 'outbox-staging', `${job.jobId}-booking.txt`);
        writeFileSync(path, `To: ${row.contact_email}\n\nSTAGING ONLY — calendar link: ${loadProvidersConfig().calendly.bookingUrl}\n`, 'utf8');
        const receipt = writeReceipt(input.db, {
          actor: 'amp-dispatch', sop: 'fleet/amp-dispatch/sops/hand-off-positive-reply.md', mode: 'setup', outcome: 'success',
          inputs: { jobId: job.jobId, prospectId }, artifacts: [{ type: 'booking-reply-draft', path }],
          notes: 'A positive-reply booking handoff was rehearsed in the file sink. No external message was sent.',
        });
        output = { sendId: relative(rootDir(), path), receiptPath: relative(rootDir(), receipt) };
      }
      completeJob(input.db, job.jobId, 'done', output.sendId, output.receiptPath);
      result.done += 1;
      result.artifacts.push(output.receiptPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isGateError(message)) {
        completeJob(input.db, job.jobId, 'blocked', null, null, message);
        result.blocked += 1;
      } else {
        retryJob(input.db, job.jobId, message);
        result.retried += 1;
      }
    }
  }
  return result;
}

export async function runDispatchCycle(input: { db: AgentAmpDb; environment: Environment; limit: number }): Promise<{ outreach: DispatchResult; booking: DispatchResult }> {
  return {
    outreach: await processOutreachQueue(input),
    booking: await processBookingQueue(input),
  };
}
