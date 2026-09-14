# Discord Coding Assistant

A self-hosted, autonomous coding agent driven from Discord.

- `/task` — implement a feature in a GitHub repo and open a PR
- `/bugreport` — reproduce a bug, fix it, and open a PR
- `/runtest` — run a repo's test suite and report results
- `/status`, `/cancel`, `/jobs` — manage jobs

Jobs are queued in Postgres, executed by workers that run an LLM agent loop (Anthropic / OpenAI / OpenRouter) against an isolated Docker sandbox, and results are posted to a Discord forum channel.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and
[docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md) for running it 24/7 on a free Oracle Cloud VM.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Monorepo scaffold, config, DB schema, CI | ✅ |
| M1 | Discord bot + API + queue, stub worker | ✅ |
| M2 | Docker sandbox, repo detection, deterministic `/runtest` | ✅ |
| M3 | LLM layer + agent loop + budgets | ✅ |
| M4 | GitHub finalize: patches, guardrails, PRs | ✅ |
| M5 | Dashboard | ✅ |
| M6 | Deployment on a free Oracle Cloud VM (24/7) | ✅ |

## Development

Requirements: Node 22+, pnpm, Docker.

```bash
pnpm install
cp .env.example .env    # fill in values, see docs/SETUP-DISCORD.md
pnpm infra:up           # Postgres (dca, dca_test) + egress proxy for sandboxes
pnpm sandbox:build      # sandbox images: dca-sandbox-node, dca-sandbox-python
pnpm db:migrate
pnpm bot:register       # once, and whenever commands change
pnpm dev                # api + worker + bot + dashboard (http://localhost:3000) with reload
```

| Script | Purpose |
|---|---|
| `pnpm dev` / `dev:api` / `dev:worker` / `dev:bot` | Run services with reload |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Vitest; DB tests need `TEST_DATABASE_URL`, Docker sandbox tests need `SANDBOX_TESTS=1` |
| `pnpm sandbox:build` | Build the sandbox images |
| `pnpm db:generate` | Generate a Drizzle migration after editing `packages/db/src/schema.ts` |

Run the integration tests locally against the throwaway test database:

```bash
TEST_DATABASE_URL=postgres://dca:dca@localhost:5432/dca_test SANDBOX_TESTS=1 pnpm test
```

## How a job flows

1. `/task` in `#create-job` → **bot** checks the allowlist and calls the **api**.
2. **api** validates the repo (bot GitHub account must be able to push), checks the monthly LLM budget, stores attachments, and inserts the job (`queued`).
3. **bot** creates the job's post in the `#responses` forum and replies with the job ID.
4. **worker** claims the job (`FOR UPDATE SKIP LOCKED`), runs it, and records every state change as a `job_events` row.
5. **bot**'s notifier delivers those events to Discord: forum tags follow the status, and the final result is posted with an @mention.

## `/runtest`

Runs the repository's existing test suite in a disposable sandbox; no LLM is involved.

1. Shallow-fetch the ref (`branch`, tag, SHA, or `#12` for a pull request) with the bot token. The token is passed through environment variables and never written to `.git/config`.
2. Detect the stack and commands (`pnpm`/`yarn`/`npm`, `vitest`/`jest`/`node --test`, `uv`/`pip`, `pytest`/`unittest`), or read them from `.agent.yml`.
3. Copy the checkout into a sandbox container: uid 1000, no capabilities, read-only root, CPU/memory/pid limits, and a network whose only exit is a proxy that allows npm and PyPI.
4. Install, run tests with a machine-readable reporter (JUnit or jest JSON), fall back to parsing console output.
5. If tests fail and an LLM key is configured, a read-only agent investigates inside the same sandbox (reads the failing tests and code, may re-run a test) and reports the likely cause, confidence, a suggested fix and file references. Limited by the `runtest` profile: 10 steps, $0.30, and the 5 minute job deadline.
6. Post a result embed with counts, the first failures, the likely cause, and the log tail attached.
7. When `ref` is a pull request (`#12`), also set an `agent/runtest` commit status and create or update one results comment on the PR.

Optional `.agent.yml` in the target repo:

```yaml
image: node            # node | python
install: pnpm install --frozen-lockfile
test: pnpm vitest run --reporter=junit --outputFile=build/junit.xml
testReport: build/junit.xml   # JUnit XML, or a jest --json file ending in .json
envFile: .env.example         # copied to .env when .env is missing
```

## `/task` and `/bugreport`

1. Shallow-fetch the base branch, detect the stack, create a sandbox, install dependencies, and snapshot the tree (so files written by setup, like a new lockfile, stay out of the PR).
2. The agent (Claude Sonnet 5 by default) explores, edits and runs the project's tooling inside the sandbox with `read_file`, `list_files`, `grep`, `bash`, `write_file` and `edit_file`. Linked issues are fetched; screenshots are passed as images and log files are copied into the sandbox. `/bugreport` asks the agent to reproduce the bug with a failing test before fixing it.
3. The agent's changes are exported as a patch and checked: no `.github/workflows`, `.agent.yml`, `.env` files, symlinks, submodules, paths outside the repo, or secret-looking strings; at most 100 files / 5,000 changed lines.
4. The test suite runs once more in the sandbox.
5. On the host, the patch is applied to a **fresh clone** (hooks disabled, system/global git config ignored), committed as the bot account, and pushed to `agent/<job-id>-<slug>`.
6. A pull request is opened: ready for review only if the agent finished and tests pass, otherwise a draft (titled `[partial] …` if the agent ran out of steps, time or budget).

The bot never pushes to an existing branch, and a token without the `workflow` scope means GitHub itself rejects workflow changes.

## Dashboard

`http://localhost:3000` in development (Vite, proxying `/api` and `/auth` to the API); in production the API serves the built files from `apps/dashboard/dist`. Sign in with Discord (same allowlist as the bot; setup in [docs/SETUP-DISCORD.md](docs/SETUP-DISCORD.md#5-dashboard-sign-in-discord-oauth)).

- **Jobs**: live list with status, type and repo filters, cost and duration.
- **Job detail**: request, result (PR, test counts, likely cause), cost/steps/time against the job's limits, event timeline, and the **agent trace**: every model call with tokens, cache hit rate, cost and latency, and each tool call with its arguments, exit code and output.
- **New job**: the same `/task`, `/bugreport` and `/runtest` inputs as Discord (results still post to the forum).
- **Costs**: month-to-date spend against `MONTHLY_LLM_CAP_USD`, daily spend, spend by command and model, most expensive jobs, and per-command limits.

Security: sessions are random tokens stored hashed in Postgres (HttpOnly, SameSite=Lax cookies, 7-day expiry); writes also require a same-origin `Origin` header; the bot's token-authenticated routes live under `/internal`.

## Agent loop and spend control

`@dca/agent` runs its own tool loop on top of the Vercel AI SDK (one model call per step, tools executed by the worker):

- Hard limits checked before every call: iterations, wall-clock deadline, per-job USD, and the monthly cap (`MONTHLY_LLM_CAP_USD`, summed from `llm_calls`).
- Every model call and tool call is stored in `llm_calls` / `tool_calls` with tokens, cost and latency.
- Falls back to the profile's fallback model on provider outages (429/5xx); other errors fail the job.
- Anthropic prompt caching via a breakpoint on the latest message; long tool outputs are clipped and old ones elided when context grows.
- Models per command can be overridden without code changes, e.g. `MODEL_RUNTEST=openrouter:<model>` and `MODEL_RUNTEST_FALLBACK=anthropic:claude-haiku-4-5`.

## Layout

```
apps/
  api/         Fastify: internal job routes for the bot, dashboard API + Discord OAuth, serves the UI
  dashboard/   Vite + React console: jobs, agent traces, new job, costs
  bot/         discord.js: slash commands, allowlist, forum publisher, notifier (outbox)
  worker/      claims jobs, heartbeats, reaps lost jobs; runners for /runtest (+ analysis) and /task, /bugreport
packages/
  agent/       tool loop with budgets and fallback, sandbox tools (read/list/grep/bash/write/edit)
  core/        env config, API contracts, job types/IDs, state machine
  db/          Drizzle schema, migrations, queue + job queries
  discord-ui/  embed and message builders
  github/      GitHub REST client, token-safe checkout, patch guardrails, fresh-clone apply + push
  llm/         AI SDK provider resolution (Anthropic, OpenAI, OpenRouter), pricing, single-step calls
  profiles/    per-command limits and models
  sandbox/     Docker sandbox provider, repo detection, .agent.yml
  test-report/ JUnit / jest JSON / console output parsers
infra/         docker compose (Postgres, egress proxy), sandbox images
docs/          architecture, Discord setup
```
