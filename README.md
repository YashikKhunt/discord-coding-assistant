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
| M1 | Discord bot + API + queue, stub worker | ✅ |
| M2 | Docker sandbox, repo detection, deterministic `/runtest` | ⏳ |
| M3 | LLM layer + agent loop + budgets | — |
| M4 | GitHub finalize: patches, guardrails, PRs | — |
| M5 | Dashboard | — |
| M6 | VPS deployment | — |

## Development

Requirements: Node 22+, pnpm, Docker.

```bash
pnpm install
cp .env.example .env    # fill in values, see docs/SETUP-DISCORD.md
pnpm infra:up           # Postgres on localhost:5432 (databases: dca, dca_test)
pnpm db:migrate
pnpm bot:register       # once, and whenever commands change
pnpm dev                # api + worker + bot with reload
```

| Script | Purpose |
|---|---|
| `pnpm dev` / `dev:api` / `dev:worker` / `dev:bot` | Run services with reload |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Vitest; integration tests run when `TEST_DATABASE_URL` is set |
| `pnpm db:generate` | Generate a Drizzle migration after editing `packages/db/src/schema.ts` |

Run the integration tests locally against the throwaway test database:

```bash
TEST_DATABASE_URL=postgres://dca:dca@localhost:5432/dca_test pnpm test
```

## How a job flows

1. `/task` in `#create-job` → **bot** checks the allowlist and calls the **api**.
2. **api** validates the repo (bot GitHub account must be able to push), checks the monthly LLM budget, stores attachments, and inserts the job (`queued`).
3. **bot** creates the job's post in the `#responses` forum and replies with the job ID.
4. **worker** claims the job (`FOR UPDATE SKIP LOCKED`), runs it, and records every state change as a `job_events` row.
5. **bot**'s notifier delivers those events to Discord: forum tags follow the status, and the final result is posted with an @mention.

## Layout

```
apps/
  api/         Fastify: create/list/get/cancel jobs, repo checks, spend cap, attachments
  bot/         discord.js: slash commands, allowlist, forum publisher, notifier (outbox)
  worker/      claims jobs, heartbeats, reaps lost jobs, runs the job runner (stub in M1)
packages/
  core/        env config, API contracts, job types/IDs, state machine
  db/          Drizzle schema, migrations, queue + job queries
  discord-ui/  embed and message builders
  github/      GitHub REST client (repo access check)
  profiles/    per-command limits and models
infra/         docker compose (Postgres)
docs/          architecture, Discord setup
```
