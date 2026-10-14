import { readFileSync, writeFileSync } from 'node:fs';
import type { AgentAmpDb } from './db.js';
import { newId } from './contracts.js';
import { artifactPath, rootDir, type Environment } from './paths.js';
import { billingArmed } from './safety.js';
import { relative, resolve } from 'node:path';

interface OfferConfig {
  setupCents: number;
  monthlyPerStoreCents: number;
}

function loadOfferConfig(): OfferConfig {
  return JSON.parse(readFileSync(resolve(rootDir(), 'config/offer.json'), 'utf8')) as OfferConfig;
}

export interface CheckoutDraft {
  billingId: string;
  status: 'draft' | 'checkout-created';
  checkoutUrl: string;
  artifactPath: string;
  duplicate: boolean;
}

export async function createCheckout(input: {
  db: AgentAmpDb;
  environment: Environment;
  storeId: string;
  agencyEmail: string;
  idempotencyKey: string;
}): Promise<CheckoutDraft> {
  const existing = input.db.prepare('SELECT * FROM billing WHERE idempotency_key = ?').get(input.idempotencyKey) as Record<string, unknown> | undefined;
  if (existing) {
    return {
      billingId: String(existing['id']),
      status: String(existing['status']) as CheckoutDraft['status'],
      checkoutUrl: String(existing['checkout_url'] ?? ''),
      artifactPath: String(existing['provider_ref'] ?? ''),
      duplicate: true,
    };
  }

  const billingId = newId('bill');
  const now = new Date().toISOString();
  const offer = loadOfferConfig();
  if (input.environment !== 'prod') {
    const path = artifactPath('state', `${input.environment}-checkout-${billingId}.json`);
    writeFileSync(path, JSON.stringify({
      mode: 'staging-draft',
      customerEmail: input.agencyEmail,
      storeId: input.storeId,
      setupCents: offer.setupCents,
      monthlyCents: offer.monthlyPerStoreCents,
      autoCharge: false,
      note: 'No Stripe request was made.',
    }, null, 2), 'utf8');
    const checkoutUrl = `file://${path}`;
    input.db.prepare(`
      INSERT INTO billing (id, store_id, setup_cents, recurring_cents, status, checkout_url, provider_ref, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
    `).run(billingId, input.storeId, offer.setupCents, offer.monthlyPerStoreCents, checkoutUrl, relative(rootDir(), path), input.idempotencyKey, now, now);
    return { billingId, status: 'draft', checkoutUrl, artifactPath: relative(rootDir(), path), duplicate: false };
  }

  if (!billingArmed(input.environment)) throw new Error('billing-disarmed: current arming receipt required');
  const secret = process.env['STRIPE_SECRET_KEY'];
  const setupPrice = process.env['AGENTAMP_STRIPE_SETUP_PRICE_ID'];
  const recurringPrice = process.env['AGENTAMP_STRIPE_RECURRING_PRICE_ID'];
  const successUrl = process.env['AGENTAMP_STRIPE_SUCCESS_URL'];
  const cancelUrl = process.env['AGENTAMP_STRIPE_CANCEL_URL'];
  if (!secret || !setupPrice || !recurringPrice || !successUrl || !cancelUrl) {
    throw new Error('billing-disarmed: Stripe references incomplete');
  }
  const form = new URLSearchParams({
    mode: 'subscription',
    customer_email: input.agencyEmail,
    client_reference_id: input.storeId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'line_items[0][price]': recurringPrice,
    'line_items[0][quantity]': '1',
    'line_items[1][price]': setupPrice,
    'line_items[1][quantity]': '1',
    'metadata[store_id]': input.storeId,
  });
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: form,
  });
  const payload = await response.json() as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !payload.id || !payload.url) throw new Error(`Stripe checkout failed: ${payload.error?.message ?? response.status}`);
  input.db.prepare(`
    INSERT INTO billing (id, store_id, setup_cents, recurring_cents, status, checkout_url, provider_ref, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'checkout-created', ?, ?, ?, ?, ?)
  `).run(billingId, input.storeId, offer.setupCents, offer.monthlyPerStoreCents, payload.url, payload.id, input.idempotencyKey, now, now);
  return { billingId, status: 'checkout-created', checkoutUrl: payload.url, artifactPath: payload.id, duplicate: false };
}
