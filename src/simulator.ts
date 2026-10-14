import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { simulationSummarySchema, type SimulationSummary } from './contracts.js';
import { rootDir, type Environment } from './paths.js';

const execFileAsync = promisify(execFile);

interface EngineConfig {
  name: string;
  root: string;
  pinnedCommit: string;
  mode: string;
  demoOrg: string;
  gatewayPackage: string;
}

export interface SimulationOutcome {
  simulation: SimulationSummary | null;
  unavailableReason: string | null;
}

function loadEngine(): EngineConfig {
  return JSON.parse(readFileSync(resolve(rootDir(), 'config/engine.json'), 'utf8')) as EngineConfig;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('could not allocate port'));
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Startup is expected to refuse connections briefly.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('gateway health timeout');
}

function stopProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

export async function runSeededSimulation(
  environment: Environment,
  input: { agents: number; seed: number },
): Promise<SimulationOutcome> {
  const engine = loadEngine();
  const engineRoot = resolve(rootDir(), engine.root);
  if (!existsSync(resolve(engineRoot, 'package.json'))) {
    return { simulation: null, unavailableReason: 'simulator engine is not configured' };
  }
  let commit: string;
  try {
    commit = execFileSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    return { simulation: null, unavailableReason: 'simulator engine commit is unavailable' };
  }
  if (commit !== engine.pinnedCommit) {
    return { simulation: null, unavailableReason: 'simulator engine pin does not match configuration' };
  }

  const port = await freePort();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const engineState = resolve(rootDir(), 'state', 'engine', `${environment}-${input.seed}`);
  mkdirSync(engineState, { recursive: true });
  let stderr = '';
  const child = spawn(
    'pnpm',
    ['--dir', engineRoot, '--filter', engine.gatewayPackage, 'exec', 'tsx', 'src/index.ts'],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(port),
        GATEWAY_URL: gatewayUrl,
        PGLITE_DATA_DIR: engineState,
        SEED_ON_START: '1',
      },
    },
  );
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(gatewayUrl, child);
    const result = await execFileAsync(
      'pnpm',
      [
        '--dir', engineRoot,
        'sim', 'run',
        '--agents', String(input.agents),
        '--org', engine.demoOrg,
        '--seed', String(input.seed),
        '--gateway', gatewayUrl,
        '--json',
      ],
      {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GATEWAY_URL: gatewayUrl },
      },
    );
    const start = result.stdout.indexOf('{');
    if (start < 0) throw new Error(`simulator returned no JSON: ${result.stdout.slice(0, 300)}`);
    const payload = JSON.parse(result.stdout.slice(start)) as {
      results: { agents: number; purchases: number; winRate: number; revenueCents: number; aovCents: number; errors: number };
    };
    return {
      simulation: simulationSummarySchema.parse({
        simulated: true,
        engine: engine.name,
        engineCommit: commit,
        org: engine.demoOrg,
        seed: input.seed,
        agents: payload.results.agents,
        purchases: payload.results.purchases,
        winRate: payload.results.winRate,
        revenueCents: payload.results.revenueCents,
        aovCents: payload.results.aovCents,
        errors: payload.results.errors,
        note: 'Staging engine verification against the seeded demo catalog; not the audited store and not real revenue.',
      }),
      unavailableReason: null,
    };
  } catch (error) {
    const detail = stderr.trim().slice(-1000);
    return { simulation: null, unavailableReason: `${error instanceof Error ? error.message : String(error)}${detail ? ` | ${detail}` : ''}` };
  } finally {
    stopProcessGroup(child);
  }
}
