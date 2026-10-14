import { randomBytes } from 'node:crypto';
import { relative } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { AgentAmpDb } from './db.js';
import { artifactPath, receiptDir, rootDir } from './paths.js';

export type ReceiptOutcome = 'success' | 'partial' | 'failure' | 'aborted-precondition' | 'aborted-killswitch';

export interface ReceiptInput {
  actor: string;
  sop: string;
  mode: 'setup' | 'launch';
  outcome: ReceiptOutcome;
  inputs: Record<string, string | number | boolean | null>;
  artifacts: Array<{ type: string; path: string }>;
  notes: string;
}

function quote(value: unknown): string {
  return JSON.stringify(value);
}

export function writeReceipt(db: AgentAmpDb, input: ReceiptInput): string {
  const now = new Date();
  const iso = now.toISOString();
  const shortId = randomBytes(2).toString('hex').toUpperCase();
  const slug = input.sop.split('/').at(-1)?.replace(/\.md$/, '') ?? 'action';
  const filename = `${iso.slice(0, 10)}-${input.actor}-${slug}-${shortId}.md`;
  const path = artifactPath(relative(rootDir(), receiptDir(now)), filename);
  const inputs = Object.entries(input.inputs).map(([key, value]) => `  ${key}: ${quote(value)}`).join('\n');
  const artifacts = input.artifacts.map((artifact) => `  - type: ${quote(artifact.type)}\n    path: ${quote(relative(rootDir(), artifact.path))}`).join('\n');
  const content = `---
timestamp: ${iso}
agent: ${input.actor}
sop: ${input.sop}
mode: ${input.mode}
inputs:
${inputs || '  none: true'}
outcome: ${input.outcome}
artifacts:
${artifacts || '  - type: receipt\n    path: ' + quote(relative(rootDir(), path))}
telegram_card:
  sent: false
---

${input.notes.trim()}
`;
  writeFileSync(path, content, 'utf8');
  const id = `rcpt_${shortId.toLowerCase()}_${Date.now()}`;
  db.prepare('INSERT INTO receipts_index (id, actor, outcome, path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, input.actor, input.outcome, relative(rootDir(), path), iso);
  return path;
}

