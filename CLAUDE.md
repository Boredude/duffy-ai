# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev               # tsx watch (starts on :3000)
pnpm build             # tsc to dist/
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint
pnpm test              # vitest run (all tests)
pnpm test -- -t "name" # run a single test by name pattern

pnpm db:generate       # diff schema.ts → new Drizzle migration
pnpm db:migrate        # apply pending migrations
pnpm db:studio         # Drizzle Studio GUI

pnpm reset-brand       # admin: wipe a brand's state (see scripts/resetBrand.ts)
```

Expose the local server for Kapso webhooks:

```bash
cloudflared tunnel --url http://localhost:3000
```

## Architecture

### Request path

```
WhatsApp → Kapso → /webhooks/kapso → inboundDispatcher
```

`src/server/routes/kapsoWebhook.ts` validates the `X-Webhook-Signature` HMAC then passes a parsed `ChannelMessage` to `dispatchInboundMessage` in `src/services/inboundDispatcher.ts`.

The dispatcher decides what to do next:
1. **Slash command** (`/reset`, `/help`) → `src/services/slashCommands.ts`
2. **Active suspended Mastra run** for this brand → `resumeWorkflow`
3. **Brand status `pending`** → start `brandOnboarding` workflow
4. **Active brand, no suspended run** → send to the `duffy` agent for free chat

### Channel abstraction

`src/channels/` is a thin vendor-neutral layer. `Channel` (unbound) and `BoundChannel` (pre-bound to a recipient) are the only interfaces the rest of the app uses — never Kapso-specific types. `src/channels/whatsapp/WhatsAppChannel.ts` is the only concrete implementation today; adding SMS/Telegram means adding a new adapter there.

### Mastra agents

Duffy (`src/mastra/agents/duffy.ts`) is the **supervisor** — the only agent the brand owner talks to. It delegates specialist work via the `delegateTo` tool to sub-agents registered in `src/mastra/agents/registry.ts`:

| Sub-agent | Role |
|---|---|
| `onboardingAgent` | Instagram scrape + brand-kit synthesis |
| `stylistAgent` | Art direction (image prompt) |
| `copywriterAgent` | Caption writing |
| `ideatorAgent` | Topic/angle selection |
| `hashtaggerAgent` | Hashtag selection |
| `schedulerAgent` | Posting cadence + timing |

The creative sub-agents (ideator, copywriter, hashtagger, stylist) are **not** reached through `delegateTo` during content generation — they are driven deterministically by `runCreativePipeline` (see below).

### Creative pipeline

`src/services/creative/runCreativePipeline.ts` is the content-generation entry point. It walks a declared pipeline DAG in order (ideation → copy → hashtags → art direction → image render), calling `runCreativeStep` for each missing artifact. The orchestration is intentionally deterministic — no LLM directs the step order. For edit reruns, an `EditDirective` invalidates only the specified steps and their downstream dependents; completed steps are reused.

### Mastra workflows

`brandOnboarding` and `postDraftApproval` are Mastra workflows that hold cross-turn conversational state via `suspend()` / `resume()`. The `workflow_runs` table maps `(brandId, runId)` so the inbound webhook can look up and resume a suspended run.

`brandOnboarding` is built dynamically from `src/mastra/onboarding/plan.ts` — adding a new onboarding step is a one-line edit to `DEFAULT_ONBOARDING_PLAN`.

### Jobs (pg-boss)

`src/jobs/workers.ts` registers three pg-boss workers:
- `weeklyPlanning` — cron, triggers the creative pipeline for each active brand
- `approvalReminder` — cron, nudges brands with pending drafts
- `deliverApprovedPost` — one-shot, fires at each draft's `scheduled_at`

All workers use the same Neon Postgres as Drizzle and Mastra storage.

### Database

Drizzle ORM + Neon Postgres. Schema lives in `src/db/schema.ts`. Migrations are committed in `drizzle/`. Auto-applied at startup via `src/db/runMigrations.ts` so deploys are self-applying.

Key tables: `brands`, `brand_channels`, `post_drafts`, `workflow_runs`, `webhook_events`.

## Agent prompt guidelines

Agent system prompts (`src/mastra/agents/*.ts`) are loaded on **every turn**. Treat prompt additions as a last resort — they pay a token cost on every message for every brand.

Before adding instructions to a system prompt, try in order:
1. **A dedicated tool** — encode the behavior in the tool's `id`, `description`, and schema.
2. **Enrich an existing tool** — add a missing output field rather than describing the lookup in prose.
3. **Delegate to a sub-agent** — multi-step specialist work belongs in its own agent.
4. **Move the decision into code** — routing and deterministic "if X then Y" logic belong in `inboundDispatcher.ts` or the relevant service.

Only edit a system prompt when the behavior is a stable, cross-cutting concern (voice rules, supervisor pattern, working-memory contract) that cannot be expressed as a tool description or service-layer rule — and compress or remove something to keep total prompt size roughly flat.

## Git worktrees (multi-agent parallel work)

Every task must be performed in a dedicated git worktree on its own branch so multiple agents can work simultaneously without stepping on each other.

```bash
# create a worktree
git fetch origin
git worktree add -b feat/<name> ../duffy-ai-feat-<name> origin/main
cd ../duffy-ai-feat-<name>

# pnpm refuses a shared virtual store — give the worktree its own install
[ -L node_modules ] && rm node_modules
pnpm install

# verify before every mutating command
git rev-parse --show-toplevel   # must print the worktree path
git branch --show-current       # must print the feature branch

# clean up after merge
git worktree remove ../duffy-ai-feat-<name>
git branch -d feat/<name>
```

Rules:
- One worktree per task. Never `git checkout` to switch branches in-place.
- Place worktrees as siblings (`../duffy-ai-<slug>`), never nested inside the repo.
- If a command fails due to the worktree environment (pnpm store, missing node_modules), fix it inside the worktree — never retry from the main checkout.
- Before finishing: confirm `git log origin/main..main --oneline` is empty and `git status --short` is clean on main.
