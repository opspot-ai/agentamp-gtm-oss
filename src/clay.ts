import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashValue, newId, type JobEnvelope } from './contracts.js';
import { enqueueJob, type AgentAmpDb } from './db.js';
import { rootDir, type Environment } from './paths.js';

export const clayProspectSchema = z.object({
  eventId: z.string().min(8),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().default(''),
  email: z.string().trim().toLowerCase().email(),
  emailVerified: z.boolean(),
  title: z.string().trim().default(''),
  agencyName: z.string().trim().min(1),
  website: z.string().url(),
  linkedinUrl: z.string().url().optional(),
  fitScore: z.number().min(0).max(100),
  signals: z.array(z.string().trim().min(1)).min(1),
  observation: z.string().trim().min(20),
  evidenceUrl: z.string().url(),
  exampleBrand: z.string().trim().default('a representative ecommerce catalog'),
  proofSummary: z.string().trim().default('The example audit identifies catalog gaps and prepares corrections without touching a live store.'),
});
export type ClayProspect = z.infer<typeof clayProspectSchema>;

interface IcpConfig {
  minimumFitScore: number;
  requireVerifiedEmail: boolean;
  requireEvidenceUrl: boolean;
  requireAgencySignal: boolean;
  acceptedSignals: string[];
}

export function loadIcpConfig(): IcpConfig {
  return JSON.parse(readFileSync(resolve(rootDir(), 'config/icp.json'), 'utf8')) as IcpConfig;
}

export interface ClayIngestResult {
  accepted: boolean;
  duplicate: boolean;
  prospectId: string;
  jobId: string | null;
  reasons: string[];
}

function jobForProspect(environment: Environment, prospectId: string, eventId: string): JobEnvelope {
  return {
    envelope: 'amp.job.v1',
    jobId: newId('job'),
    product: 'agentamp',
    environment,
    stage: 'gtm.outreach',
    actor: 'amp-drafter',
    entityRefs: { prospectId },
    inputRefs: [`clay:${eventId}`],
    idempotencyKey: `${environment}:clay:${eventId}:outreach`,
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

export function qualifyClayProspect(prospect: ClayProspect, icp: IcpConfig): string[] {
  const reasons: string[] = [];
  if (prospect.fitScore < icp.minimumFitScore) reasons.push(`fit-score-below-${icp.minimumFitScore}`);
  if (icp.requireVerifiedEmail && !prospect.emailVerified) reasons.push('email-not-verified');
  if (icp.requireEvidenceUrl && !prospect.evidenceUrl) reasons.push('evidence-url-missing');
  const acceptedSignals = new Set(icp.acceptedSignals.map((signal) => signal.toLowerCase()));
  if (icp.requireAgencySignal && !prospect.signals.some((signal) => acceptedSignals.has(signal.toLowerCase()))) {
    reasons.push('agency-signal-missing');
  }
  return reasons;
}

export function ingestClayProspect(input: {
  db: AgentAmpDb;
  environment: Environment;
  raw: unknown;
  icp: IcpConfig;
}): ClayIngestResult {
  const prospect = clayProspectSchema.parse(input.raw);
  const reasons = qualifyClayProspect(prospect, input.icp);
  const accepted = reasons.length === 0;
  const prospectId = `prospect_${hashValue(prospect.email).slice(0, 20)}`;
  const now = new Date().toISOString();
  const evidence = {
    source: 'clay',
    sourceEventId: prospect.eventId,
    firstName: prospect.firstName,
    lastName: prospect.lastName,
    title: prospect.title,
    linkedinUrl: prospect.linkedinUrl ?? null,
    fitScore: prospect.fitScore,
    signals: prospect.signals,
    observation: prospect.observation,
    evidenceUrl: prospect.evidenceUrl,
    exampleBrand: prospect.exampleBrand,
    proofSummary: prospect.proofSummary,
    evidenceHash: hashValue(prospect),
  };
  const result = input.db.prepare(`
    INSERT INTO prospects (id, name, website, contact_email, evidence_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_email) DO UPDATE SET
      name = excluded.name,
      website = excluded.website,
      evidence_json = excluded.evidence_json,
      status = excluded.status
  `).run(prospectId, prospect.agencyName, prospect.website, prospect.email, JSON.stringify(evidence), accepted ? 'qualified' : 'rejected', now);

  if (!accepted) return { accepted, duplicate: result.changes === 0, prospectId, jobId: null, reasons };
  const queued = enqueueJob(input.db, jobForProspect(input.environment, prospectId, prospect.eventId));
  return { accepted, duplicate: !queued.created, prospectId, jobId: queued.job.jobId, reasons };
}
