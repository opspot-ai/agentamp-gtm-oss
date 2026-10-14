import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { environmentSchema } from './paths.js';

export const jobStageSchema = z.enum([
  'gtm.prospect',
  'gtm.outreach',
  'gtm.reply',
  'gtm.book',
  'fulfil.intake',
  'fulfil.audit',
  'fulfil.report',
  'fulfil.deliver',
  'bill.checkout',
  'study.draft',
]);

export const actorSchema = z.enum([
  'amp-dispatch',
  'amp-mailer',
  'amp-prospector',
  'amp-analyst',
  'amp-drafter',
  'amp-reviewer',
  'amp-scribe',
  'svc-feed',
  'svc-sim',
  'svc-report',
  'svc-warmup',
  'svc-suppress',
  'svc-billing',
  'svc-metrics',
  'svc-backup',
]);

export const jobStatusSchema = z.enum(['queued', 'running', 'blocked', 'done', 'failed', 'killed']);
export const gateSchema = z.enum(['none', 'agency_approval', 'owner_approval']);

export const jobEnvelopeSchema = z.object({
  envelope: z.literal('amp.job.v1').default('amp.job.v1'),
  jobId: z.string().min(8),
  product: z.literal('agentamp').default('agentamp'),
  environment: environmentSchema,
  stage: jobStageSchema,
  actor: actorSchema,
  entityRefs: z.record(z.string(), z.string()).default({}),
  inputRefs: z.array(z.string()).default([]),
  idempotencyKey: z.string().min(8),
  gate: gateSchema.default('none'),
  capsSnapshot: z.record(z.string(), z.number()).default({}),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().min(1).max(3).default(3),
  deadline: z.string().datetime().nullable().default(null),
  status: jobStatusSchema.default('queued'),
  resultRef: z.string().nullable().default(null),
  receiptRef: z.string().nullable().default(null),
});
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export const catalogProductSchema = z.object({
  externalId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  brand: z.string().default(''),
  category: z.string().default(''),
  imageUrl: z.string().default(''),
  sku: z.string().default(''),
  priceCents: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative().nullable().default(null),
  inventoryQty: z.number().int().default(0),
  tags: z.array(z.string()).default([]),
});
export type CatalogProduct = z.infer<typeof catalogProductSchema>;

export const findingSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  productId: z.string().nullable(),
  message: z.string(),
  correction: z.string(),
});

export const simulationSummarySchema = z.object({
  simulated: z.literal(true),
  engine: z.string(),
  engineCommit: z.string(),
  org: z.string(),
  seed: z.number().int(),
  agents: z.number().int(),
  purchases: z.number().int(),
  winRate: z.number(),
  revenueCents: z.number().int(),
  aovCents: z.number().int(),
  errors: z.number().int(),
  note: z.string(),
});
export type SimulationSummary = z.infer<typeof simulationSummarySchema>;

export const auditResultSchema = z.object({
  contract: z.literal('audit.v1'),
  auditId: z.string(),
  agencyId: z.string(),
  storeId: z.string(),
  generatedAt: z.string().datetime(),
  inputHash: z.string(),
  score: z.number().min(0).max(100),
  productsChecked: z.number().int().nonnegative(),
  findings: z.array(findingSchema),
  simulation: simulationSummarySchema.nullable(),
  simulationUnavailableReason: z.string().nullable(),
});
export type AuditResult = z.infer<typeof auditResultSchema>;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
