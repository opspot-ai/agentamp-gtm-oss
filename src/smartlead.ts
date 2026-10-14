import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { newId } from './contracts.js';
import type { AgentAmpDb } from './db.js';
import type { OutreachDraft, OutreachReview } from './outreach.js';
import { rootDir, type Environment } from './paths.js';
import { writeReceipt } from './receipts.js';
import { assertSendAllowed } from './safety.js';

interface ProvidersConfig {
  smartlead: {
    baseUrl: string;
    campaignName: string;
    campaignId: number | null;
    initialMaxLeadsPerDay: number;
    timezone: string;
    days: number[];
    startHour: string;
    endHour: string;
    minTimeBetweenEmailsMinutes: number;
  };
  calendly: { bookingUrl: string };
}

interface SmartleadResponse {
  ok?: boolean;
  success?: boolean;
  id?: number;
  added_count?: number;
  skipped_count?: number;
  lead_ids?: number[];
  message?: string;
  error?: string;
}


export interface SmartleadQueueResult {
  sendId: string;
  campaignId: number;
  leadId: number | null;
  duplicate: boolean;
  receiptPath: string;
}

export function loadProvidersConfig(): ProvidersConfig {
  return JSON.parse(readFileSync(resolve(rootDir(), 'config/providers.json'), 'utf8')) as ProvidersConfig;
}

function apiKey(): string {
  const value = process.env['SMARTLEAD_API_KEY'];
  if (!value) throw new Error('smartlead-disarmed: SMARTLEAD_API_KEY missing');
  return value;
}

function campaignId(): number {
  const configured = process.env['SMARTLEAD_CAMPAIGN_ID'] ?? String(loadProvidersConfig().smartlead.campaignId ?? '');
  const value = Number(configured);
  if (!Number.isInteger(value) || value <= 0) throw new Error('smartlead-disarmed: campaign ID missing');
  return value;
}

async function callSmartlead<T = SmartleadResponse>(path: string, init: RequestInit = {}): Promise<T> {
  const config = loadProvidersConfig();
  const url = new URL(`${config.smartlead.baseUrl}${path}`);
  url.searchParams.set('api_key', apiKey());
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const payload = await response.json() as T & SmartleadResponse;
  if (!response.ok) throw new Error(`smartlead-${response.status}: ${payload.error ?? payload.message ?? 'request failed'}`);
  return payload;
}

async function resolveEmailStatsId(targetCampaignId: number, leadId: string, supplied?: string): Promise<string> {
  if (supplied) return supplied;
  const history = await callSmartlead<{ messages?: Array<{ id?: string | number; direction?: string }> }>(
    `/campaigns/${targetCampaignId}/leads/${encodeURIComponent(leadId)}/message-history?show_plain_text_response=false`,
  );
  const message = [...(history.messages ?? [])].reverse().find((item) => item.direction === 'inbound' && item.id !== undefined);
  if (!message?.id) throw new Error('email-stats-id-missing: Smartlead did not return an inbound thread ID');
  return String(message.id);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char] ?? char);
}

function textToHtml(value: string): string {
  return value.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`).join('');
}

export async function createSmartleadDraftCampaign(): Promise<{ campaignId: number; name: string }> {
  const config = loadProvidersConfig();
  const created = await callSmartlead('/campaigns/create', {
    method: 'POST',
    body: JSON.stringify({ name: config.smartlead.campaignName }),
  });
  if (!created.id) throw new Error('smartlead-create-campaign: missing campaign ID');
  return configureSmartleadDraftCampaign(created.id);
}

export async function configureSmartleadDraftCampaign(id: number): Promise<{ campaignId: number; name: string }> {
  const config = loadProvidersConfig();
  await callSmartlead(`/campaigns/${id}/sequences`, {
    method: 'POST',
    body: JSON.stringify({
      sequences: [
        {
          id: null,
          seq_number: 1,
          subject: '{{agentamp_subject}}',
          email_body: '{{agentamp_body_html}}',
          seq_delay_details: { delay_in_days: 0 },
        },
        {
          id: null,
          seq_number: 2,
          subject: '',
          email_body: '<p>Hi {{first_name}} — one last note. If a co-branded AI-shopping audit would help one of your ecommerce clients, here is the configured calendar link: {{agentamp_booking_url}}</p><p>If not, reply “no” and I will close the loop.</p>',
          seq_delay_details: { delay_in_days: 4 },
        },
      ],
    }),
  });
  await callSmartlead(`/campaigns/${id}/schedule`, {
    method: 'POST',
    body: JSON.stringify({
      timezone: config.smartlead.timezone,
      days_of_the_week: config.smartlead.days,
      start_hour: config.smartlead.startHour,
      end_hour: config.smartlead.endHour,
      min_time_btw_emails: config.smartlead.minTimeBetweenEmailsMinutes,
      max_new_leads_per_day: config.smartlead.initialMaxLeadsPerDay,
    }),
  });
  await callSmartlead(`/campaigns/${id}/settings`, {
    method: 'POST',
    body: JSON.stringify({
      name: config.smartlead.campaignName,
      track_settings: ['DONT_TRACK_EMAIL_OPEN', 'DONT_TRACK_LINK_CLICK'],
      stop_lead_settings: 'REPLY_TO_AN_EMAIL',
      send_as_plain_text: false,
      follow_up_percentage: 100,
      enable_ai_esp_matching: true,
    }),
  });
  return { campaignId: id, name: config.smartlead.campaignName };
}

export async function queueApprovedSmartleadLead(input: {
  db: AgentAmpDb;
  environment: Environment;
  jobId: string;
  idempotencyKey: string;
  draft: OutreachDraft;
  review: OutreachReview;
}): Promise<SmartleadQueueResult> {
  if (input.environment !== 'prod') throw new Error('smartlead-production-only: use file sink outside production');
  if (!input.review.approved || input.review.reviewer !== 'amp-reviewer') throw new Error('review-required');
  assertSendAllowed(input.db, input.environment, input.draft.recipient);
  const existing = input.db.prepare('SELECT id, status, provider_response_json FROM sends WHERE idempotency_key = ?').get(input.idempotencyKey) as { id: string; status: string; provider_response_json: string } | undefined;
  if (existing) {
    if (!['queued', 'sent'].includes(existing.status)) throw new Error(`smartlead-send-uncertain: existing attempt is ${existing.status}; reconcile before retry`);
    const provider = JSON.parse(existing.provider_response_json) as { campaignId?: number; leadId?: number; receiptPath?: string };
    return {
      sendId: existing.id,
      campaignId: provider.campaignId ?? campaignId(),
      leadId: provider.leadId ?? null,
      duplicate: true,
      receiptPath: provider.receiptPath ?? '',
    };
  }

  const targetCampaignId = campaignId();
  const sendId = newId('send');
  const now = new Date().toISOString();
  input.db.prepare(`
    INSERT INTO sends (id, job_id, prospect_id, recipient, subject, body, provider, status, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'smartlead', 'attempting', ?, ?)
  `).run(sendId, input.jobId, input.draft.evidence.prospectId, input.draft.recipient, input.draft.subject, input.draft.body, input.idempotencyKey, now);

  try {
    const names = (input.draft.evidence.firstName ?? '').split(/\s+/);
    const response = await callSmartlead(`/campaigns/${targetCampaignId}/leads`, {
      method: 'POST',
      body: JSON.stringify({
        lead_list: [{
          email: input.draft.recipient,
          first_name: names[0] ?? '',
          company_name: input.draft.evidence.agencyName,
          company_url: input.draft.evidence.website,
          custom_fields: {
            agentamp_subject: input.draft.subject,
            agentamp_body_html: textToHtml(input.draft.body),
            agentamp_booking_url: loadProvidersConfig().calendly.bookingUrl,
            agentamp_prospect_id: input.draft.evidence.prospectId,
            agentamp_evidence: input.draft.evidence.observation,
          },
        }],
        settings: {
          ignore_global_block_list: false,
          ignore_unsubscribe_list: false,
          ignore_duplicate_leads_in_other_campaign: false,
          ignore_community_bounce_list: false,
          return_lead_ids: true,
        },
      }),
    });
    const leadId = response.lead_ids?.[0] ?? null;
    if ((response.added_count ?? 0) < 1 || leadId === null) throw new Error(`lead-not-added: ${response.message ?? 'Smartlead skipped lead'}`);
    const receiptPath = writeReceipt(input.db, {
      actor: 'amp-mailer',
      sop: 'fleet/amp-mailer/sops/queue-reviewed-smartlead-lead.md',
      mode: 'launch',
      outcome: 'success',
      inputs: { jobId: input.jobId, recipient: input.draft.recipient, campaignId: targetCampaignId, leadId },
      artifacts: [],
      notes: 'The independently reviewed lead was queued in the bounded Smartlead campaign. Smartlead has not yet emitted an EMAIL_SENT receipt.',
    });
    const providerResponse = JSON.stringify({ campaignId: targetCampaignId, leadId, receiptPath: relative(rootDir(), receiptPath) });
    input.db.prepare(`UPDATE sends SET status = 'queued', provider_response_json = ? WHERE id = ?`).run(providerResponse, sendId);
    input.db.prepare(`
      INSERT INTO provider_links (id, provider, entity_type, internal_id, external_id, metadata_json, created_at)
      VALUES (?, 'smartlead', 'lead', ?, ?, ?, ?)
    `).run(newId('link'), sendId, String(leadId), JSON.stringify({ campaignId: targetCampaignId }), now);
    return { sendId, campaignId: targetCampaignId, leadId, duplicate: false, receiptPath: relative(rootDir(), receiptPath) };
  } catch (error) {
    input.db.prepare(`UPDATE sends SET status = 'failed', provider_response_json = ? WHERE id = ?`)
      .run(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), sendId);
    throw error;
  }
}


export async function sendSmartleadBookingReply(input: {
  db: AgentAmpDb;
  environment: Environment;
  jobId: string;
  prospectId: string;
  emailStatsId?: string;
  campaignId: string;
  leadId: string;
  recipient: string;
  firstName?: string;
  idempotencyKey: string;
}): Promise<{ sendId: string; duplicate: boolean; receiptPath: string }> {
  if (input.environment !== 'prod') throw new Error('smartlead-production-only: booking replies use a file artifact outside production');
  assertSendAllowed(input.db, input.environment, input.recipient);
  const existing = input.db.prepare('SELECT id, status, provider_response_json FROM sends WHERE idempotency_key = ?').get(input.idempotencyKey) as { id: string; status: string; provider_response_json: string } | undefined;
  if (existing) {
    if (existing.status !== 'sent') throw new Error(`smartlead-reply-uncertain: existing attempt is ${existing.status}; reconcile before retry`);
    const provider = JSON.parse(existing.provider_response_json) as { receiptPath?: string };
    return { sendId: existing.id, duplicate: true, receiptPath: provider.receiptPath ?? '' };
  }

  const sendId = newId('send');
  const now = new Date().toISOString();
  const greeting = input.firstName?.trim() ? `Thanks ${input.firstName.trim()} —` : 'Thanks —';
  const body = `${greeting} here is the configured calendar link: ${loadProvidersConfig().calendly.bookingUrl}\n\nPick any time that works and I’ll come prepared with the short agency example.\n\n— AgentAmp`;
  input.db.prepare(`
    INSERT INTO sends (id, job_id, prospect_id, recipient, subject, body, provider, status, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, 'Re: AgentAmp agency example', ?, 'smartlead-reply', 'attempting', ?, ?)
  `).run(sendId, input.jobId, input.prospectId, input.recipient, body, input.idempotencyKey, now);
  try {
    const targetCampaignId = Number(input.campaignId) || campaignId();
    const emailStatsId = await resolveEmailStatsId(targetCampaignId, input.leadId, input.emailStatsId);
    await callSmartlead(`/campaigns/${targetCampaignId}/reply-email-thread`, {
      method: 'POST',
      body: JSON.stringify({ email_stats_id: emailStatsId, email_body: textToHtml(body), add_signature: false }),
    });
    const receiptPath = writeReceipt(input.db, {
      actor: 'amp-mailer',
      sop: 'fleet/amp-mailer/sops/send-booking-link.md',
      mode: 'launch',
      outcome: 'success',
      inputs: { jobId: input.jobId, recipient: input.recipient },
      artifacts: [],
      notes: 'A bounded calendar-link reply was sent in the existing Smartlead thread after a positive reply.',
    });
    const relativeReceipt = relative(rootDir(), receiptPath);
    input.db.prepare(`UPDATE sends SET status = 'sent', sent_at = ?, provider_response_json = ? WHERE id = ?`)
      .run(now, JSON.stringify({ receiptPath: relativeReceipt }), sendId);
    return { sendId, duplicate: false, receiptPath: relativeReceipt };
  } catch (error) {
    input.db.prepare(`UPDATE sends SET status = 'failed', provider_response_json = ? WHERE id = ?`)
      .run(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), sendId);
    throw error;
  }
}
