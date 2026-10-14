import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { clayProspectSchema, ingestClayProspect } from './clay.js';
import { enqueueJob, type AgentAmpDb } from './db.js';
import { hashValue, newId, type JobEnvelope } from './contracts.js';
import { classifyReply } from './replies.js';
import { addSuppression } from './safety.js';
import type { Environment } from './paths.js';
import { writeReceipt } from './receipts.js';

const smartleadEventSchema = z.object({
  event: z.string(),
  timestamp: z.string(),
  campaign_id: z.union([z.string(), z.number()]),
  lead_id: z.union([z.string(), z.number()]),
  email_account_id: z.union([z.string(), z.number()]).optional(),
  email_stats_id: z.union([z.string(), z.number()]).optional(),
  sequence_number: z.number().optional(),
  lead: z.object({ email: z.string().email(), first_name: z.string().optional(), last_name: z.string().optional() }),
  reply: z.object({ subject: z.string().optional(), body: z.string(), received_at: z.string().optional(), message_id: z.string().optional() }).optional(),
}).passthrough();

const calendlyEventSchema = z.object({
  event: z.string(),
  created_at: z.string().optional(),
  payload: z.object({
    email: z.string().email(),
    uri: z.string().optional(),
    event: z.union([z.string(), z.object({ uri: z.string().optional(), start_time: z.string().optional() })]).optional(),
    cancel_url: z.string().optional(),
    reschedule_url: z.string().optional(),
  }).passthrough(),
}).passthrough();

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return equalSecret(header.slice(7), expected);
}

export function verifyHmac(raw: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  return equalSecret(signature.replace(/^sha256=/, ''), expected);
}

function insertProviderEvent(db: AgentAmpDb, provider: string, externalId: string, eventType: string, raw: unknown): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO provider_events (id, provider, external_id, event_type, payload_json, status, received_at)
    VALUES (?, ?, ?, ?, ?, 'received', ?)
  `).run(newId('evt'), provider, externalId, eventType, JSON.stringify(raw), new Date().toISOString());
  return result.changes === 1;
}

function finishProviderEvent(db: AgentAmpDb, provider: string, externalId: string, status: string, error: string | null = null): void {
  db.prepare(`UPDATE provider_events SET status = ?, processed_at = ?, error = ? WHERE provider = ? AND external_id = ?`)
    .run(status, new Date().toISOString(), error, provider, externalId);
}

export function handleClayWebhook(input: {
  db: AgentAmpDb;
  environment: Environment;
  raw: unknown;
  icp: Parameters<typeof ingestClayProspect>[0]['icp'];
}): ReturnType<typeof ingestClayProspect> & { eventDuplicate: boolean } {
  const prospect = clayProspectSchema.parse(input.raw);
  if (!insertProviderEvent(input.db, 'clay', prospect.eventId, 'prospect.enriched', prospect)) {
    const existing = input.db.prepare('SELECT id, status FROM prospects WHERE contact_email = ?').get(prospect.email) as { id: string; status: string } | undefined;
    return { accepted: existing?.status === 'qualified', duplicate: true, eventDuplicate: true, prospectId: existing?.id ?? '', jobId: null, reasons: [] };
  }
  try {
    const result = ingestClayProspect({ db: input.db, environment: input.environment, raw: prospect, icp: input.icp });
    finishProviderEvent(input.db, 'clay', prospect.eventId, 'processed');
    return { ...result, eventDuplicate: false };
  } catch (error) {
    finishProviderEvent(input.db, 'clay', prospect.eventId, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function bookingJob(
  environment: Environment,
  prospectId: string,
  replyId: string,
  sendId: string,
  campaignId: string,
  leadId: string,
  emailStatsId?: string,
): JobEnvelope {
  return {
    envelope: 'amp.job.v1', jobId: newId('job'), product: 'agentamp', environment,
    stage: 'gtm.book', actor: 'amp-dispatch', entityRefs: {
      prospectId, replyId, sendId, campaignId, leadId, ...(emailStatsId ? { emailStatsId } : {}),
    }, inputRefs: [],
    idempotencyKey: `${environment}:reply:${replyId}:book`, gate: 'none', capsSnapshot: {}, attempts: 0,
    maxAttempts: 3, deadline: null, status: 'queued', resultRef: null, receiptRef: null,
  };
}

export function handleSmartleadWebhook(input: { db: AgentAmpDb; environment: Environment; raw: unknown }): { duplicate: boolean; event: string; classification?: string } {
  const event = smartleadEventSchema.parse(input.raw);
  const externalId = event.reply?.message_id ?? hashValue({ event: event.event, timestamp: event.timestamp, campaignId: event.campaign_id, leadId: event.lead_id });
  if (!insertProviderEvent(input.db, 'smartlead', externalId, event.event, event)) return { duplicate: true, event: event.event };
  try {
    const link = input.db.prepare(`SELECT internal_id FROM provider_links WHERE provider = 'smartlead' AND entity_type = 'lead' AND external_id = ?`)
      .get(String(event.lead_id)) as { internal_id: string } | undefined;
    if (!link) {
      finishProviderEvent(input.db, 'smartlead', externalId, 'ignored', 'lead-link-missing');
      return { duplicate: false, event: event.event };
    }
    const sendId = link.internal_id;
    if (event.event === 'EMAIL_SENT') {
      input.db.prepare(`UPDATE sends SET status = 'sent', sent_at = ? WHERE id = ?`).run(event.timestamp, sendId);
    } else if (event.event === 'EMAIL_BOUNCED') {
      input.db.prepare(`UPDATE sends SET status = 'bounced' WHERE id = ?`).run(sendId);
      addSuppression(input.db, event.lead.email, 'smartlead-bounce', 'provider reported bounce');
    } else if (event.event === 'EMAIL_REPLIED' && event.reply) {
      const classification = classifyReply(event.reply.body);
      const replyId = `reply_${hashValue(externalId).slice(0, 20)}`;
      input.db.prepare(`
        INSERT OR IGNORE INTO replies (id, send_id, classification, body, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(replyId, sendId, classification, event.reply.body, `smartlead:${externalId}`, event.reply.received_at ?? event.timestamp);
      const send = input.db.prepare('SELECT prospect_id FROM sends WHERE id = ?').get(sendId) as { prospect_id: string };
      input.db.prepare('UPDATE prospects SET status = ? WHERE id = ?').run(`reply-${classification}`, send.prospect_id);
      if (classification === 'opt-out') addSuppression(input.db, event.lead.email, 'smartlead-reply', 'explicit opt-out');
      if (classification === 'positive') enqueueJob(input.db, bookingJob(
        input.environment,
        send.prospect_id,
        replyId,
        sendId,
        String(event.campaign_id),
        String(event.lead_id),
        event.email_stats_id === undefined ? undefined : String(event.email_stats_id),
      ));
      writeReceipt(input.db, {
        actor: 'amp-mailer', sop: 'fleet/amp-mailer/sops/process-smartlead-event.md', mode: 'launch', outcome: 'success',
        inputs: { providerEvent: event.event, sendId, classification }, artifacts: [],
        notes: classification === 'positive'
          ? 'A positive reply was stored and a booking handoff was queued for amp-dispatch.'
          : `A Smartlead reply was stored as ${classification}; suppression was applied when required.`,
      });
      finishProviderEvent(input.db, 'smartlead', externalId, 'processed');
      return { duplicate: false, event: event.event, classification };
    }
    finishProviderEvent(input.db, 'smartlead', externalId, 'processed');
    return { duplicate: false, event: event.event };
  } catch (error) {
    finishProviderEvent(input.db, 'smartlead', externalId, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function handleCalendlyWebhook(input: { db: AgentAmpDb; raw: unknown }): { duplicate: boolean; event: string; meetingId?: string } {
  const event = calendlyEventSchema.parse(input.raw);
  const externalId = event.payload.uri ?? hashValue(event);
  if (!insertProviderEvent(input.db, 'calendly', externalId, event.event, event)) return { duplicate: true, event: event.event };
  try {
    if (event.event !== 'invitee.created') {
      finishProviderEvent(input.db, 'calendly', externalId, 'ignored');
      return { duplicate: false, event: event.event };
    }
    const prospect = input.db.prepare('SELECT id FROM prospects WHERE contact_email = ?').get(event.payload.email.toLowerCase()) as { id: string } | undefined;
    const eventData = typeof event.payload.event === 'object' ? event.payload.event : {};
    const meetingId = `meeting_${hashValue(externalId).slice(0, 20)}`;
    const now = new Date().toISOString();
    input.db.prepare(`
      INSERT OR IGNORE INTO meetings (id, prospect_id, provider, external_id, invitee_email, start_at, status, booking_url, payload_json, created_at, updated_at)
      VALUES (?, ?, 'calendly', ?, ?, ?, 'booked', ?, ?, ?, ?)
    `).run(meetingId, prospect?.id ?? null, externalId, event.payload.email.toLowerCase(), eventData.start_time ?? null, event.payload.reschedule_url ?? null, JSON.stringify(event), now, now);
    if (prospect) input.db.prepare(`UPDATE prospects SET status = 'meeting-booked' WHERE id = ?`).run(prospect.id);
    finishProviderEvent(input.db, 'calendly', externalId, 'processed');
    return { duplicate: false, event: event.event, meetingId };
  } catch (error) {
    finishProviderEvent(input.db, 'calendly', externalId, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
