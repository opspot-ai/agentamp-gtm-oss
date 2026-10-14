import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { mailArmState, billingArmed } from './safety.js';
import { rootDir } from './paths.js';

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

interface EngineConfig {
  root: string;
  pinnedCommit: string;
  mode: string;
}

interface LaunchGates {
  checkedAt: string;
  launchReady: boolean;
  checks: Record<string, string>;
}

export function runDoctor(): { ok: boolean; checks: DoctorCheck[] } {
  const root = rootDir();
  const checks: DoctorCheck[] = [];
  const productHomeReady = existsSync(root) && !lstatSync(root).isSymbolicLink();
  checks.push({
    name: 'product-home',
    status: productHomeReady ? 'pass' : 'fail',
    detail: 'Product state must stay in a real, dedicated directory.',
  });

  const launchGatesPath = resolve(root, 'config/launch-gates.json');
  if (!existsSync(launchGatesPath)) {
    checks.push({ name: 'provider-readiness', status: 'warn', detail: 'No provider readiness snapshot exists.' });
  } else {
    const gates = JSON.parse(readFileSync(launchGatesPath, 'utf8')) as LaunchGates;
    const blockers = Object.entries(gates.checks).filter(([, value]) => value.startsWith('blocked') || value === 'pending');
    checks.push({
      name: 'provider-readiness',
      status: gates.launchReady && blockers.length === 0 ? 'pass' : 'warn',
      detail: gates.launchReady ? 'Provider readiness is recorded as ready.' : 'Provider readiness is unverified or not configured.',
    });
  }

  const enginePath = resolve(root, 'config/engine.json');
  if (!existsSync(enginePath)) {
    checks.push({ name: 'simulator-pin', status: 'warn', detail: 'Simulator configuration is missing.' });
  } else {
    const engine = JSON.parse(readFileSync(enginePath, 'utf8')) as EngineConfig;
    let current = '';
    try {
      current = execFileSync('git', ['-C', resolve(root, engine.root), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // An unconfigured simulator is reported below.
    }
    checks.push({
      name: 'simulator-pin',
      status: current && current === engine.pinnedCommit && engine.mode === 'read-only-external-engine' ? 'pass' : 'warn',
      detail: current ? `Configured simulator commit: ${current}.` : 'Simulator engine is unconfigured or unavailable.',
    });
  }

  try {
    const db = openDatabase('staging');
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    checks.push({ name: 'state-database', status: row.foreign_keys === 1 ? 'pass' : 'fail', detail: 'SQLite is reachable with foreign keys enabled.' });
    db.close();
  } catch {
    checks.push({ name: 'state-database', status: 'fail', detail: 'SQLite could not be opened.' });
  }

  const dispatchRoom = resolve(root, 'fleet/amp-dispatch/AGENTS.md');
  const mailerRoom = resolve(root, 'fleet/amp-mailer/AGENTS.md');
  checks.push({
    name: 'role-rooms',
    status: existsSync(dispatchRoom) && existsSync(mailerRoom) ? 'pass' : 'fail',
    detail: 'Dispatch and mailer role files must both exist.',
  });
  checks.push({
    name: 'production-mail',
    status: mailArmState('prod')?.armed ? 'warn' : 'pass',
    detail: mailArmState('prod')?.armed ? 'Production mail has an arm file; verify expiry and receipt before use.' : 'Disarmed by default.',
  });
  checks.push({
    name: 'production-billing',
    status: billingArmed('prod') ? 'warn' : 'pass',
    detail: billingArmed('prod') ? 'Production billing has an arm file.' : 'Disarmed by default.',
  });
  return { ok: checks.every((check) => check.status !== 'fail'), checks };
}
