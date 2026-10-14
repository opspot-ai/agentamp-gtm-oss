import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentAmpDb } from './db.js';
import { rootDir, type Environment } from './paths.js';

interface Bounds {
  initialDailySendsPerMailbox: number;
  secondRampDailySendsPerMailbox: number;
  hardDailySendsPerMailbox: number;
  hardWeeklySendsProductWide: number;
  maxAttempts: number;
  sendWindow: {
    timezone: string;
    weekdays: number[];
    startHour: number;
    endHour: number;
  };
}

interface ArmState {
  armed: boolean;
  verifiedAt: string;
  expiresAt: string;
  receiptPath: string;
  dailyCap: number;
}

export function loadBounds(): Bounds {
  return JSON.parse(readFileSync(resolve(rootDir(), 'config/bounds.json'), 'utf8')) as Bounds;
}

export function assertNotKilled(actor: 'amp-dispatch' | 'amp-mailer' | 'product'): void {
  const paths = [resolve(rootDir(), '.killed')];
  if (actor !== 'product') paths.push(resolve(rootDir(), 'fleet', actor, '.killed'));
  const tripped = paths.find((path) => existsSync(path));
  if (tripped) throw new Error(`aborted-killswitch: ${tripped}`);
}

export function isSuppressed(db: AgentAmpDb, email: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM suppression WHERE email = ?').get(email.trim().toLowerCase()));
}

export function addSuppression(db: AgentAmpDb, email: string, source: string, reason: string): void {
  db.prepare(`
    INSERT INTO suppression (email, source, reason, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO NOTHING
  `).run(email.trim().toLowerCase(), source, reason, new Date().toISOString());
}

export function mailArmState(environment: Environment): ArmState | null {
  const path = resolve(rootDir(), 'state', 'arming', `${environment}-mail.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as ArmState;
}

export function billingArmed(environment: Environment): boolean {
  if (environment !== 'prod') return false;
  const path = resolve(rootDir(), 'state', 'arming', `${environment}-billing.json`);
  if (!existsSync(path)) return false;
  const state = JSON.parse(readFileSync(path, 'utf8')) as { armed?: boolean; expiresAt?: string };
  return state.armed === true && Boolean(state.expiresAt) && Date.parse(state.expiresAt!) > Date.now();
}

function sentSince(db: AgentAmpDb, since: Date): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM sends WHERE status = 'sent' AND sent_at >= ?`).get(since.toISOString()) as { count: number };
  return row.count;
}

function startOfDay(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfWeek(): Date {
  const now = new Date();
  const day = now.getDay();
  const delta = day === 0 ? 6 : day - 1;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - delta);
}

export function assertSendAllowed(db: AgentAmpDb, environment: Environment, recipient: string): void {
  assertNotKilled('amp-mailer');
  if (isSuppressed(db, recipient)) throw new Error(`suppressed: ${recipient}`);
  if (environment !== 'prod') return;

  const bounds = loadBounds();
  const arm = mailArmState(environment);
  if (!arm?.armed) throw new Error('mail-disarmed: no current arming receipt');
  if (Date.parse(arm.expiresAt) <= Date.now()) throw new Error('mail-disarmed: arming receipt expired');
  if (!arm.receiptPath) throw new Error('mail-disarmed: verification receipt missing');
  const cap = Math.min(arm.dailyCap, bounds.hardDailySendsPerMailbox);
  if (sentSince(db, startOfDay()) >= cap) throw new Error(`daily-cap-reached: ${cap}`);
  if (sentSince(db, startOfWeek()) >= bounds.hardWeeklySendsProductWide) {
    throw new Error(`weekly-cap-reached: ${bounds.hardWeeklySendsProductWide}`);
  }
  const local = new Date();
  const day = local.getDay();
  const hour = local.getHours();
  if (!bounds.sendWindow.weekdays.includes(day) || hour < bounds.sendWindow.startHour || hour >= bounds.sendWindow.endHour) {
    throw new Error('outside-send-window');
  }
}

