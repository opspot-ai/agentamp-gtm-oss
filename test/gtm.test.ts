import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { ingestClayProspect, loadIcpConfig } from '../src/clay.js';
import { newId } from '../src/contracts.js';
import { openDatabase, type AgentAmpDb } from '../src/db.js';
import { processBookingQueue, processOutreachQueue } from '../src/dispatch.js';
import { rootDir } from '../src/paths.js';
import { createWebhookServer } from '../src/server.js';
import { handleCalendlyWebhook, handleSmartleadWebhook } from '../src/webhooks.js';

let db: AgentAmpDb;

const prospect = {
  eventId: 'synthetic-event-0001', firstName: 'Synthetic', lastName: 'Contact', email: 'demo@example.invalid',
  emailVerified: true, title: 'Synthetic role', agencyName: 'Synthetic Agency', website: 'https://example.invalid/booking-event',
  fitScore: 100, signals: ['synthetic-agency'], observation: 'Synthetic observation for privacy review only.',
  evidenceUrl: 'https://example.invalid/booking-event', exampleBrand: 'Synthetic Brand',
  proofSummary: 'Synthetic proof text; no real evidence or customer data.',
};

beforeEach(() => {
  rmSync(rootDir(), { recursive: true, force: true });
  mkdirSync(resolve(rootDir(), 'config'), { recursive: true });
  writeFileSync(resolve(rootDir(), 'config/icp.json'), JSON.stringify({
    minimumFitScore: 100, requireVerifiedEmail: true, requireEvidenceUrl: true, requireAgencySignal: true,
    acceptedSignals: ['synthetic-agency'],
  }));
  writeFileSync(resolve(rootDir(), 'config/providers.json'), JSON.stringify({
    smartlead: { baseUrl: 'https://example.invalid/booking-event', campaignName: 'SYNTHETIC_TEST_CAMPAIGN', campaignId: 0, initialMaxLeadsPerDay: 0, timezone: 'Etc/UTC', days: [], startHour: '00:00', endHour: '00:00', minTimeBetweenEmailsMinutes: 0 },
    calendly: { bookingUrl: 'https://example.invalid/booking-event' }, clay: { mode: 'unconfigured-placeholder', minimumFitScore: 100 },
  }));
  db = openDatabase('staging', { reset: true });
});

afterEach(() => {
  db.close();
  delete process.env['CLAY_WEBHOOK_TOKEN'];
});

function ingest(): string {
  const result = ingestClayProspect({ db, environment: 'staging', raw: prospect, icp: loadIcpConfig() });
  expect(result.accepted).toBe(true);
  return result.prospectId;
}

describe('agentic GTM loop', () => {
  it('qualifies Clay evidence and rehearses reviewed outreach exactly once', async () => {
    const first = ingestClayProspect({ db, environment: 'staging', raw: prospect, icp: loadIcpConfig() });
    const duplicate = ingestClayProspect({ db, environment: 'staging', raw: prospect, icp: loadIcpConfig() });
    expect(first.accepted).toBe(true);
    expect(duplicate.duplicate).toBe(true);
    const result = await processOutreachQueue({ db, environment: 'staging', limit: 5 });
    expect(result).toMatchObject({ claimed: 1, done: 1, blocked: 0 });
    const send = db.prepare(`SELECT status, provider, provider_response_json FROM sends`).get() as { status: string; provider: string; provider_response_json: string };
    expect(send).toMatchObject({ status: 'sent', provider: 'file-sink' });
    const artifact = JSON.parse(send.provider_response_json) as { artifactPath: string };
    expect(existsSync(artifact.artifactPath)).toBe(true);
  });

  it('rejects weak or unverified Clay prospects before the queue', () => {
    const result = ingestClayProspect({ db, environment: 'staging', raw: { ...prospect, eventId: 'synthetic-event-0002', fitScore: 40, emailVerified: false }, icp: loadIcpConfig() });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['fit-score-below-100', 'email-not-verified']));
    expect((db.prepare(`SELECT COUNT(*) AS count FROM jobs`).get() as { count: number }).count).toBe(0);
  });

  it('turns a positive Smartlead reply into a calendar handoff and a Calendly booking receipt', async () => {
    const prospectId = ingest();
    await processOutreachQueue({ db, environment: 'staging', limit: 5 });
    const send = db.prepare(`SELECT id FROM sends`).get() as { id: string };
    db.prepare(`INSERT INTO provider_links (id, provider, entity_type, internal_id, external_id, created_at) VALUES (?, 'smartlead', 'lead', ?, 'synthetic-lead-001', ?)`)
      .run(newId('link'), send.id, new Date().toISOString());
    const reply = {
      event: 'EMAIL_REPLIED', timestamp: new Date().toISOString(), campaign_id: 'synthetic-campaign-id', lead_id: 'synthetic-lead-001',
      lead: { email: prospect.email, first_name: prospect.firstName },
      reply: { body: 'Yes, send the example and let us talk.', message_id: 'synthetic-message-001' },
    };
    expect(handleSmartleadWebhook({ db, environment: 'staging', raw: reply })).toMatchObject({ classification: 'positive', duplicate: false });
    expect(handleSmartleadWebhook({ db, environment: 'staging', raw: reply }).duplicate).toBe(true);
    const bookingJob = db.prepare(`SELECT entity_refs_json FROM jobs WHERE stage = 'gtm.book'`).get() as { entity_refs_json: string };
    expect(JSON.parse(bookingJob.entity_refs_json)).toMatchObject({ campaignId: 'synthetic-campaign-id', leadId: 'synthetic-lead-001' });
    const booking = await processBookingQueue({ db, environment: 'staging', limit: 5 });
    expect(booking).toMatchObject({ claimed: 1, done: 1, blocked: 0 });
    const calendly = handleCalendlyWebhook({ db, raw: {
      event: 'invitee.created', payload: { email: prospect.email, uri: 'https://example.invalid/booking-event', event: { start_time: new Date().toISOString() } },
    } });
    expect(calendly.duplicate).toBe(false);
    expect((db.prepare(`SELECT status FROM prospects WHERE id = ?`).get(prospectId) as { status: string }).status).toBe('meeting-booked');
    expect((db.prepare(`SELECT COUNT(*) AS count FROM meetings`).get() as { count: number }).count).toBe(1);
  });

  it('suppresses bounces and protects the Clay webhook with a token', async () => {
    ingest();
    await processOutreachQueue({ db, environment: 'staging', limit: 5 });
    const send = db.prepare(`SELECT id FROM sends`).get() as { id: string };
    db.prepare(`INSERT INTO provider_links (id, provider, entity_type, internal_id, external_id, created_at) VALUES (?, 'smartlead', 'lead', ?, 'synthetic-lead-002', ?)`)
      .run(newId('link'), send.id, new Date().toISOString());
    handleSmartleadWebhook({ db, environment: 'staging', raw: {
      event: 'EMAIL_BOUNCED', timestamp: new Date().toISOString(), campaign_id: 'synthetic-campaign-id', lead_id: 'synthetic-lead-002', lead: { email: prospect.email },
    } });
    expect((db.prepare(`SELECT COUNT(*) AS count FROM suppression WHERE email = ?`).get(prospect.email) as { count: number }).count).toBe(1);

    process.env['CLAY_WEBHOOK_TOKEN'] = 'SYNTHETIC_WEBHOOK_TOKEN_PLACEHOLDER';
    const server = createWebhookServer({ environment: 'staging', db });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/clay`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
