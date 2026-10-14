# AgentAmp Operations — experimental snapshot

AgentAmp Operations is a Node.js and TypeScript codebase for a local ecommerce catalog audit and review-gated outreach workflow. It models prospect intake, catalog checks, local message drafts, provider events, reports, and receipts.

## Prerequisites

- Node.js 24 or later, as declared in `package.json`.
- pnpm for the checked-in lockfile and package scripts; the project does not pin a pnpm version.
- Local filesystem write access for SQLite state, receipts, and generated artifacts.

## Configuration

The JSON files under `config/` contain synthetic placeholders. Provider URLs and IDs, send limits, commercial terms, margin settings, and simulator settings are unconfigured. `config/claims-policy.md` records generic evidence constraints. Replace them with values for your own environment before attempting provider-backed commands. No credentials are included.

## Documented commands (unverified)

The package declares these commands. They were not run while preparing this snapshot:

```sh
pnpm install
pnpm amp -- status --env staging
pnpm amp -- demo --env staging --reset
pnpm verify
```

`pnpm verify` invokes the package's typecheck, test, build, demo, and doctor scripts. None of those checks was run for this sanitation release.

## Limits

This is an experimental as-is snapshot. Its bugs, unfinished features, dependencies, and runtime behavior have not been evaluated or repaired here. Clean installation, builds, tests, local workflows, provider connections, simulator behavior, hosted operation, and security behavior are unverified. The placeholder configuration is not an operating setup. Do not infer production readiness or successful customer outcomes from the source.

See `LICENSE` for the MIT license.
