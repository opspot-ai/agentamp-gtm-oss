import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const environmentSchema = z.enum(['dev', 'staging', 'prod']);
export type Environment = z.infer<typeof environmentSchema>;

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function rootDir(): string {
  const override = process.env['AGENTAMP_ROOT'];
  if (!override) return sourceRoot;
  return isAbsolute(override) ? override : resolve(process.cwd(), override);
}

export function ensureLayout(): void {
  const root = rootDir();
  for (const path of [
    'state',
    'state/arming',
    'state/backups',
    'state/engine',
    'state/outbox-dev',
    'state/outbox-staging',
    'receipts',
    'clients',
    'gtm/agencies',
    'gtm/prospects',
  ]) {
    mkdirSync(resolve(root, path), { recursive: true });
  }
}

export function databasePath(environment: Environment): string {
  return resolve(rootDir(), 'state', `agentamp-${environment}.db`);
}

export function receiptDir(date = new Date()): string {
  const month = date.toISOString().slice(0, 7);
  const path = resolve(rootDir(), 'receipts', month);
  mkdirSync(path, { recursive: true });
  return path;
}

export function artifactPath(...segments: string[]): string {
  const path = resolve(rootDir(), ...segments);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

