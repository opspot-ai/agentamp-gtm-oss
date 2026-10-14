#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { addSuppression } from './safety.js';
import { openDatabase, statusSnapshot } from './db.js';
import { environmentSchema, type Environment } from './paths.js';
import { runDemo } from './demo.js';
import { runDoctor } from './doctor.js';
import { ingestClayProspect, loadIcpConfig } from './clay.js';
import { runDispatchCycle } from './dispatch.js';
import { configureSmartleadDraftCampaign, createSmartleadDraftCampaign } from './smartlead.js';
import { startWebhookServer } from './server.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function environment(): Environment {
  return environmentSchema.parse(flag('--env') ?? 'staging');
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[process.argv[2] === '--' ? 3 : 2] ?? 'status';
  if (command === 'demo') {
    print(await runDemo(environment(), process.argv.includes('--reset')));
    return;
  }
  if (command === 'migrate') {
    const db = openDatabase(environment());
    print({ ok: true, environment: environment(), counts: statusSnapshot(db) });
    db.close();
    return;
  }
  if (command === 'status') {
    const db = openDatabase(environment());
    print({ environment: environment(), counts: statusSnapshot(db) });
    db.close();
    return;
  }
  if (command === 'suppress') {
    const email = flag('--email');
    if (!email) throw new Error('Usage: amp suppress --email <email> [--env staging]');
    const db = openDatabase(environment());
    addSuppression(db, email, 'operator-cli', flag('--reason') ?? 'operator request');
    db.close();
    print({ ok: true, email: email.toLowerCase(), environment: environment() });
    return;
  }
  if (command === 'ingest-clay') {
    const file = flag('--file');
    if (!file) throw new Error('Usage: amp ingest-clay --file prospect.json [--env staging]');
    const target = environment();
    const db = openDatabase(target);
    try {
      print(ingestClayProspect({ db, environment: target, raw: JSON.parse(readFileSync(file, 'utf8')), icp: loadIcpConfig() }));
    } finally {
      db.close();
    }
    return;
  }
  if (command === 'dispatch') {
    const target = environment();
    const db = openDatabase(target);
    try {
      print(await runDispatchCycle({ db, environment: target, limit: Number(flag('--limit') ?? '5') }));
    } finally {
      db.close();
    }
    return;
  }
  if (command === 'serve') {
    const target = environment();
    const port = Number(flag('--port') ?? process.env['PORT'] ?? '4317');
    const server = await startWebhookServer({ environment: target, port });
    print({ ok: true, environment: target, address: server.address() });
    const close = () => server.close();
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (command === 'smartlead-setup') {
    const existing = Number(flag('--campaign-id') ?? '0');
    print(existing > 0 ? await configureSmartleadDraftCampaign(existing) : await createSmartleadDraftCampaign());
    return;
  }
  if (command === 'doctor') {
    const result = runDoctor();
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
