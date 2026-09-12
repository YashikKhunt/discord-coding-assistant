# Discord Coding Assistant

A self-hosted, autonomous coding agent driven from Discord.

- `/task` — implement a feature in a GitHub repo and open a PR
- `/bugreport` — reproduce a bug, fix it, and open a PR
- `/runtest` — run a repo's test suite and report results
- `/status`, `/cancel`, `/jobs` — manage jobs

Jobs are queued in Postgres, executed by workers that run an LLM agent loop (Anthropic / OpenAI / OpenRouter) against an isolated Docker sandbox, and results are posted to a Discord forum channel.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Monorepo scaffold, config, DB schema, CI | ✅ |
| M1 | Discord bot + API + queue, stub worker | ⏳ |
| M2 | Docker sandbox, repo detection, deterministic `/runtest` | — |
| M3 | LLM layer + agent loop + budgets | — |
| M4 | GitHub finalize: patches, guardrails, PRs | — |
| M5 | Dashboard | — |
| M6 | VPS deployment | — |

## Development

Requirements: Node 22+, pnpm, Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # Postgres on localhost:5432
pnpm db:migrate
pnpm test
```

| Script | Purpose |
|---|---|
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Vitest (DB integration tests run when `DATABASE_URL` is set) |
| `pnpm db:generate` | Generate a Drizzle migration after editing `packages/db/src/schema.ts` |

## Layout

```
apps/        bot, api, worker, dashboard (from M1)
packages/
  core/      env config, job types, job ID format, state machine
  db/        Drizzle schema, migrations, queries
infra/       docker compose
docs/        architecture
```
