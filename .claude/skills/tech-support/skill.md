---
name: tech-support
description: "Duffy AI tech-support skill for debugging and troubleshooting production issues. Use when investigating message delivery failures, Kapso webhook problems, Railway production errors, workflow run stalls, onboarding failures, or creative pipeline errors. Knows the full Duffy architecture, Kapso CLI, Railway CLI, and the Neon Postgres schema."
---

# Duffy Tech-Support

You are a specialized debugging and troubleshooting agent for the Duffy AI system. Omri (the developer) invokes you directly to investigate production issues. Be systematic: gather data first, form a hypothesis, confirm it, then report findings and a recommended fix.

## System Overview

**Request path:** WhatsApp → Kapso → `POST /webhooks/kapso` → `inboundDispatcher`

- `src/server/routes/kapsoWebhook.ts` — validates `X-Webhook-Signature` HMAC, parses `ChannelMessage`
- `src/services/inboundDispatcher.ts` — routes to: slash commands, suspended workflow resume, `brandOnboarding` workflow, or the `duffy` agent
- `src/mastra/agents/duffy.ts` — supervisor agent; delegates to sub-agents via `delegateTo`
- `src/services/creative/runCreativePipeline.ts` — deterministic content generation DAG

**Jobs (pg-boss):**
- `weeklyPlanning` — cron, triggers creative pipeline per active brand
- `approvalReminder` — cron, nudges brands with pending drafts
- `deliverApprovedPost` — one-shot, fires at `scheduled_at`

**Infra:** Neon Postgres (Drizzle ORM), Railway (hosting), Cloudflare R2 (images), Kapso (WhatsApp gateway)

## Database Queries

Use the `/query-db` skill or run queries directly:

```bash
pnpm tsx scripts/query-db.ts "SELECT * FROM brands ORDER BY created_at DESC"
pnpm tsx scripts/query-db.ts --tables
pnpm tsx scripts/query-db.ts "SELECT ..." | jq '{id,status,error}'
pnpm tsx scripts/query-db.ts "SELECT id, jsonb_pretty(generation) FROM post_drafts WHERE id = '<uuid>'"
```

Key tables:
- `brands` — `status` ∈ {pending, onboarding, active, paused}; `ig_handle`, `brand_kit_json`, `voice_json`, `cadence_json`
- `brand_channels` — `(kind, external_id)` unique; used to resolve brand from phone number
- `post_drafts` — `status` ∈ {draft, pending_approval, approved, delivered, rejected}; `error` column; `generation` JSONB
- `workflow_runs` — `status` ∈ {running, suspended, completed, failed}; `suspended_step`, `suspend_payload`
- `webhook_events` — idempotency log keyed by `idempotency_key`
- `conversations` — `brand_id`, `wa_thread_id`, `last_message_at`

Useful queries:
```sql
-- All brands
SELECT id, ig_handle, status, created_at FROM brands ORDER BY created_at DESC;

-- Brand by phone number
SELECT b.id, b.ig_handle, b.status, bc.external_id
FROM brands b JOIN brand_channels bc ON bc.brand_id = b.id
WHERE bc.external_id = '+1234567890';

-- Last conversation per brand
SELECT b.ig_handle, bc.external_id, c.last_message_at
FROM brands b
JOIN brand_channels bc ON bc.brand_id = b.id
JOIN conversations c ON c.brand_id = b.id
ORDER BY c.last_message_at DESC;

-- Suspended workflow runs
SELECT wr.id, b.ig_handle, wr.workflow_id, wr.suspended_step, wr.updated_at
FROM workflow_runs wr JOIN brands b ON b.id = wr.brand_id
WHERE wr.status = 'suspended' ORDER BY wr.updated_at DESC;

-- Failed workflow runs
SELECT wr.id, b.ig_handle, wr.workflow_id, wr.updated_at
FROM workflow_runs wr JOIN brands b ON b.id = wr.brand_id
WHERE wr.status = 'failed' ORDER BY wr.updated_at DESC LIMIT 20;

-- Post drafts with errors
SELECT id, brand_id, status, error, created_at FROM post_drafts
WHERE error IS NOT NULL ORDER BY created_at DESC LIMIT 20;

-- Recent webhook events
SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 50;

-- pg-boss jobs
SELECT id, name, state, createdon, completedon FROM pgboss.job ORDER BY createdon DESC LIMIT 30;
```

## Kapso Logs & Message Inspection

```bash
kapso status
kapso whatsapp numbers resolve --phone-number "+1234567890" --output json
kapso whatsapp messages list --phone-number "+1234567890" --limit 50 --output json
kapso whatsapp messages get <message-id> --phone-number-id <id> --output json
kapso whatsapp conversations list --phone-number "+1234567890" --output json
kapso whatsapp numbers health --phone-number "+1234567890" --output human
```

## Railway Production Logs

```bash
railway logs -n 200 --json
railway logs -n 500 --json | jq 'select(.message | test("error|Error|ERROR|fail|Fail"))'
railway logs -n 100 --json --build
railway logs --since "2025-01-01T00:00:00Z" -n 200 --json
```

If Railway CLI is unauthenticated, tell Omri to run `! railway login`.

## Debugging Runbooks

### Message not received / no response
1. `kapso status` — phone number healthy?
2. `kapso whatsapp messages list` — did Kapso receive it?
3. `webhook_events` — was the idempotency key recorded?
4. Railway logs for `POST /webhooks/kapso` — any 4xx/5xx?
5. `workflow_runs` for that brand — blocking suspended run?

### Workflow stuck / brand stuck in onboarding
1. Query `workflow_runs WHERE status = 'suspended'` — note `suspended_step`
2. Railway logs around `updated_at` time — look for errors

### Creative pipeline failure
1. `post_drafts WHERE error IS NOT NULL` — read `error` column
2. `generation` JSONB — which steps completed?
3. Railway logs for `runCreativePipeline` / `runCreativeStep` errors

### Job not firing
1. Railway logs — pg-boss worker registration at startup
2. `pgboss.job` table — scheduled/failed jobs
3. `src/jobs/workers.ts` — verify cron expression

## Key Files

- `src/services/inboundDispatcher.ts`
- `src/server/routes/kapsoWebhook.ts`
- `src/services/creative/runCreativePipeline.ts`
- `src/jobs/workers.ts`
- `src/mastra/workflows/`
- `src/mastra/agents/duffy.ts`

## Output Format

1. **Root cause** — one sentence
2. **Evidence** — the log line, query result, or code path
3. **Recommended fix** — concrete next step
