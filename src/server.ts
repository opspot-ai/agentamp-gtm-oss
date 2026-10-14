import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { openDatabase, statusSnapshot, type AgentAmpDb } from './db.js';
import { loadIcpConfig } from './clay.js';
import { type Environment } from './paths.js';
import { handleCalendlyWebhook, handleClayWebhook, handleSmartleadWebhook, verifyBearer } from './webhooks.js';

const MAX_BODY_BYTES = 256 * 1024;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('payload-too-large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function pathToken(pathname: string, prefix: string, expected: string | undefined): boolean {
  return Boolean(expected) && pathname === `${prefix}/${encodeURIComponent(expected!)}`;
}

export function createWebhookServer(input: { environment: Environment; db?: AgentAmpDb }): Server {
  const db = input.db ?? openDatabase(input.environment);
  const ownsDb = !input.db;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { ok: true, environment: input.environment, counts: statusSnapshot(db) });
        return;
      }
      if (request.method !== 'POST') {
        json(response, 404, { ok: false, error: 'not-found' });
        return;
      }
      if (url.pathname === '/webhooks/clay') {
        const expected = process.env['CLAY_WEBHOOK_TOKEN'];
        if (!expected || !verifyBearer(request.headers.authorization, expected)) {
          json(response, expected ? 401 : 503, { ok: false, error: expected ? 'unauthorized' : 'clay-webhook-disarmed' });
          return;
        }
        json(response, 200, { ok: true, result: handleClayWebhook({ db, environment: input.environment, raw: await body(request), icp: loadIcpConfig() }) });
        return;
      }
      if (url.pathname.startsWith('/webhooks/smartlead/')) {
        if (!pathToken(url.pathname, '/webhooks/smartlead', process.env['SMARTLEAD_WEBHOOK_TOKEN'])) {
          json(response, process.env['SMARTLEAD_WEBHOOK_TOKEN'] ? 401 : 503, { ok: false, error: process.env['SMARTLEAD_WEBHOOK_TOKEN'] ? 'unauthorized' : 'smartlead-webhook-disarmed' });
          return;
        }
        json(response, 200, { ok: true, result: handleSmartleadWebhook({ db, environment: input.environment, raw: await body(request) }) });
        return;
      }
      if (url.pathname.startsWith('/webhooks/calendly/')) {
        if (!pathToken(url.pathname, '/webhooks/calendly', process.env['CALENDLY_WEBHOOK_TOKEN'])) {
          json(response, process.env['CALENDLY_WEBHOOK_TOKEN'] ? 401 : 503, { ok: false, error: process.env['CALENDLY_WEBHOOK_TOKEN'] ? 'unauthorized' : 'calendly-webhook-disarmed' });
          return;
        }
        json(response, 200, { ok: true, result: handleCalendlyWebhook({ db, raw: await body(request) }) });
        return;
      }
      json(response, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'payload-too-large' ? 413 : message.includes('JSON') ? 400 : 422;
      json(response, status, { ok: false, error: message });
    }
  });
  if (ownsDb) server.once('close', () => db.close());
  return server;
}

export async function startWebhookServer(input: { environment: Environment; port: number; host?: string }): Promise<Server> {
  const server = createWebhookServer({ environment: input.environment });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host ?? '127.0.0.1', resolve);
  });
  return server;
}
