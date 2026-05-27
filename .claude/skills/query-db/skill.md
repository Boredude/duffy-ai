---
name: query-db
description: "Query and inspect the Duffy Neon Postgres database. Use for browsing brands, post drafts, workflow runs, webhook events, and any other table. Supports arbitrary SQL and pre-built debugging recipes. Use when investigating data state, checking brand status, inspecting stuck workflows, or looking at draft errors."
---

# Query Neon DB

## How to run queries

No `psql` required — use the project's `query-db` script via `tsx`:

```bash
# Arbitrary SQL → newline-delimited JSON (pipe to jq for filtering)
pnpm tsx scripts/query-db.ts "SELECT * FROM brands ORDER BY created_at DESC"

# List all tables
pnpm tsx scripts/query-db.ts --tables

# Pipe SQL from stdin
echo "SELECT id, status FROM brands" | pnpm tsx scripts/query-db.ts

# Filter output with jq
pnpm tsx scripts/query-db.ts "SELECT * FROM post_drafts WHERE error IS NOT NULL" \
  | jq '{id, status, error}'
```

Results go to **stdout** (one JSON object per row). Row count goes to **stderr**.

The script reads `DATABASE_URL` from `.env` automatically.

## Schema quick reference

| Table | Key columns | Notes |
|---|---|---|
| `brands` | `id`, `ig_handle`, `status`, `brand_kit_json`, `voice_json`, `cadence_json`, `timezone` | `status` ∈ {pending, onboarding, active, paused} |
| `brand_channels` | `brand_id`, `kind`, `external_id`, `is_primary`, `status` | `(kind, external_id)` unique — used to resolve brand from phone number |
| `post_drafts` | `id`, `brand_id`, `caption`, `status`, `error`, `generation`, `scheduled_at` | `status` ∈ {draft, pending_approval, approved, delivered, rejected}; `error` column holds pipeline failures |
| `workflow_runs` | `id`, `brand_id`, `run_id`, `workflow_id`, `status`, `suspended_step`, `suspend_payload` | `status` ∈ {running, suspended, completed, failed} |
| `webhook_events` | `idempotency_key`, `source`, `received_at` | Idempotency dedupe log |
| `conversations` | `brand_id`, `wa_thread_id`, `last_message_at` | WhatsApp thread tracking |

## Common debugging queries

```sql
-- All brands and their status
SELECT id, ig_handle, status, created_at FROM brands ORDER BY created_at DESC;

-- Brand by phone number (resolves brand_channels → brands)
SELECT b.id, b.ig_handle, b.status, bc.external_id
FROM brands b JOIN brand_channels bc ON bc.brand_id = b.id
WHERE bc.external_id = '+1234567890';

-- Suspended workflow runs (stuck conversations)
SELECT wr.id, wr.brand_id, b.ig_handle, wr.workflow_id,
       wr.suspended_step, wr.updated_at
FROM workflow_runs wr JOIN brands b ON b.id = wr.brand_id
WHERE wr.status = 'suspended'
ORDER BY wr.updated_at DESC;

-- Failed workflow runs
SELECT wr.id, b.ig_handle, wr.workflow_id, wr.updated_at
FROM workflow_runs wr JOIN brands b ON b.id = wr.brand_id
WHERE wr.status = 'failed'
ORDER BY wr.updated_at DESC LIMIT 20;

-- Post drafts with pipeline errors
SELECT id, brand_id, status, error, created_at
FROM post_drafts WHERE error IS NOT NULL
ORDER BY created_at DESC LIMIT 20;

-- Pending-approval drafts (waiting for user response)
SELECT pd.id, b.ig_handle, pd.status, pd.scheduled_at, pd.created_at
FROM post_drafts pd JOIN brands b ON b.id = pd.brand_id
WHERE pd.status = 'pending_approval'
ORDER BY pd.created_at DESC;

-- Recent webhook events (last 50)
SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 50;

-- Webhook events in the last hour
SELECT * FROM webhook_events
WHERE received_at > NOW() - INTERVAL '1 hour'
ORDER BY received_at DESC;
```

## GUI option

Launch Drizzle Studio in the browser for a visual table explorer:

```bash
pnpm db:studio
```

## Notes

- `generation` and `suspend_payload` are JSONB — use `->` / `->>` operators or `jsonb_pretty()` in queries:
  ```sql
  SELECT id, jsonb_pretty(generation) FROM post_drafts WHERE id = '<uuid>';
  ```
- Timestamps are stored with timezone (`timestamptz`). Results come back in UTC; convert with `AT TIME ZONE 'America/New_York'` if needed.
- The script exits after each query — it does not hold a persistent connection.
