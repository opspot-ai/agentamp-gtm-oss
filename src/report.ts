import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuditResult } from './contracts.js';
import { artifactPath, rootDir } from './paths.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char] ?? char);
}

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function renderAuditReport(input: {
  audit: AuditResult;
  agencyName: string;
  storeName: string;
  coBrand: string;
}): string {
  const findings = input.audit.findings.map((finding) => `
    <article class="finding ${finding.severity}">
      <div class="tag">${escapeHtml(finding.severity.toUpperCase())}</div>
      <h3>${escapeHtml(finding.message)}</h3>
      <p><strong>Prepared correction:</strong> ${escapeHtml(finding.correction)}</p>
    </article>`).join('');
  const simulation = input.audit.simulation
    ? `<section><h2>Staging simulator verification</h2>
        <div class="metrics">
          <div><b>${input.audit.simulation.agents}</b><span>simulated shoppers</span></div>
          <div><b>${input.audit.simulation.purchases}</b><span>simulated purchases</span></div>
          <div><b>${(input.audit.simulation.winRate * 100).toFixed(1)}%</b><span>simulated win rate</span></div>
          <div><b>${money(input.audit.simulation.revenueCents)}</b><span>simulated revenue</span></div>
        </div><p class="disclaimer">${escapeHtml(input.audit.simulation.note)}</p></section>`
    : `<section><h2>Simulation</h2><p>Simulation was not included: ${escapeHtml(input.audit.simulationUnavailableReason ?? 'engine unavailable')} No result was invented.</p></section>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.storeName)} AgentAmp audit</title>
<style>
body{font-family:Inter,ui-sans-serif,system-ui;background:#11140f;color:#171a14;margin:0;padding:48px}main{max-width:960px;margin:auto;background:#fbfaf2;border-radius:28px;padding:48px;box-shadow:0 24px 80px #0008}header{border-bottom:4px solid #a8ff3e;padding-bottom:28px;margin-bottom:36px}.eyebrow,.tag{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#2459ff}h1{font-size:52px;line-height:1;margin:10px 0}h2{margin-top:40px}.score{display:inline-block;background:#a8ff3e;padding:10px 18px;border-radius:999px;font-weight:900}.finding{border:1px solid #d8d8cf;border-left:8px solid #f1b83b;border-radius:16px;padding:20px;margin:16px 0}.finding.critical{border-left-color:#e54b4b}.finding.info{border-left-color:#2459ff}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metrics div{background:#171a14;color:#fff;border-radius:16px;padding:18px}.metrics b,.metrics span{display:block}.metrics b{font-size:26px;color:#a8ff3e}.metrics span{font-size:12px;margin-top:5px}.disclaimer{font-size:13px;color:#6c6e66}footer{margin-top:44px;border-top:1px solid #d8d8cf;padding-top:22px;font-size:13px;color:#6c6e66}@media(max-width:700px){body{padding:12px}main{padding:24px}h1{font-size:36px}.metrics{grid-template-columns:1fr 1fr}}
</style></head><body><main>
<header><div class="eyebrow">${escapeHtml(input.coBrand)}</div><h1>${escapeHtml(input.storeName)} agent-shopping audit</h1><p>Prepared for ${escapeHtml(input.agencyName)} · ${escapeHtml(input.audit.generatedAt.slice(0,10))}</p><span class="score">Catalog score ${input.audit.score}/100</span></header>
<section><h2>What we checked</h2><p>${input.audit.productsChecked} catalog records were checked for agent-readable product data, availability, variant identity, and margin-policy readiness. The separate staging simulation below verifies the engine pipeline; it does not model this store's real sales.</p></section>
<section><h2>Prepared improvements</h2>${findings || '<p>No material feed issues were found.</p>'}</section>
${simulation}
<footer>This is a testing and recommendation report. It does not claim real orders or guaranteed revenue. No live-store changes were made.</footer>
</main></body></html>`;
  const path = artifactPath('clients', input.agencyName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), input.storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), `${input.audit.auditId}.html`);
  writeFileSync(path, html, 'utf8');
  return resolve(rootDir(), path);
}
