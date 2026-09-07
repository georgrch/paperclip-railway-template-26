# paperclip-railway

## Codex API cost reporting (local compatibility patch)

This wrapper keeps `paperclipai: latest` and reapplies an optional, tested patch
at image build time. Tested against `2026.831.1`, whose Codex CLI adapter returns
`costUsd: null` for API-key runs, despite parsing token usage.

### Enable and verify

1. Review your installed and target versions before deploying. Back up your Railway PostgreSQL database
   and persistent volume before deploying any application update.
2. Review this branch and its CI checks. Merge only when ready to deploy;
   Railway may automatically deploy changes to your connected branch.
3. In each affected Codex agent's adapter configuration, use an explicit
   supported model (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, or `gpt-6-astra`). Both CLI
   and ACP are supported when their token semantics pass compatibility checks.
   ACP remains the upstream default. Keep your existing API-key secrets.
   The patch does not change existing agent configurations for you.
4. On the next normal completed run with token usage, look for
   `[codex-cost-estimate] USD ...` in the run log and a cost in Paperclip.
   Runs without a usable price or usage produce an explanatory `Unpriced` log.

The patch wraps the existing adapter result and sets `costUsd` only when no
upstream cost exists. Paperclip's existing ledger creates the event and uses it
for its existing budgeting machinery; no separate cost events or database
changes are made. Existing token counts, output, errors, and sessions are kept.
Subscription and non-OpenAI billing are left unchanged.

**These are standard-rate estimates, not reconciled invoice amounts.** The
normal Paperclip cost UI does not gain a new "estimated" badge from this patch;
the provenance is recorded in run logs and `resultJson.codexCostEstimate`.
CLI input totals include cache reads; ACP input already excludes them. The
patch handles those separately. Output is charged once, including reasoning already in
the reported total. Run-level aggregates cannot identify per-request
long-context premiums, Fast/Flex/Batch tiers, discounts or unreported usage;
tool charges are excluded. Verify actual spend against your provider billing.
Paperclip rounds costs to cents per run, so sub-cent runs can still show zero.
This patch only prices future runs. Use the optional worker below for historical runs.

If an ACP run lacks its required token breakdown, it remains unpriced with an
explanatory log; explicitly setting `"engine": "cli"` is an alternative.
Pricing is an explicit four-model table in
`scripts/codex-costs.mjs` with source links and the verification date. Unknown
models remain unpriced instead of receiving a guessed price.

### Updates and rollback

- Paperclip remains on `latest`; image builds install without a lockfile. Use
  an uncached rebuild to fetch updates: restarting or redeploying an existing
  image alone does not download a new release. This preserves the original
  update approach, including its risk of unrelated upstream breaking changes.
- The patch checks a unique exported execution function and each engine's
  cache-token conversion. Compatible updates are patched automatically. If an
  engine's conversion changes, that lane stays unpriced with a warning. If the
  execution entry point or package layout changes, installation logs
  `PATCH SKIPPED` and allows the build to continue. New code is never changed
  using a guessed replacement. These checks are conservative compatibility
  checks, not a guarantee of future upstream behavior.
- CI runs unit tests and a Docker build, plus advisory tests against the real
  installed adapter. Upstream compatibility failures do not block Paperclip
  updates. Inspect build/run warnings after updating; cost reporting may need
  maintenance even while Paperclip itself continues to work.
- When upstream implements cost reporting, remove the compatibility patch's
  build step after validating the new release. The wrapper already preserves
  any non-null upstream cost, including zero.
- To stop estimating without changing code, set
  `PAPERCLIP_CODEX_COST_ESTIMATES=0` in Railway and restart/redeploy. This affects
  future runs only and does not erase ledger records. Budget enforcement may
  already have paused an agent; review it before resuming.
- You can roll back to a previously working Railway image. If a version update
  ran database migrations, image rollback alone may be insufficient; use your
  backup and that release's migration guidance. This cost patch itself adds no
  migrations and never edits credentials or the persistent volume.

Local checks (no model calls or production connection):

```sh
npm install --omit=dev --package-lock=false
npm test
npm run test:integration
npm run build
```

### Historical costs and the optional Railway worker

There are two independent components:

- The adapter patch prices new runs as they finish in Paperclip.
- The small worker in `worker/` scans saved runs once and repairs
  existing **unpriced** ledger entries. It can run after startup in the existing
  Railway service, or independently if desired. It needs PostgreSQL access,
  not an OpenAI key, Paperclip login, public domain, or persistent volume.

Both share the same Sol/Terra/Luna/Astra rate table. Paperclip still comes from
`paperclipai: latest`; this repository is its deployment wrapper, not a pinned
fork of the Paperclip application. Changes to the original wrapper template
still require normal Git synchronization. Neither component guarantees
compatibility with every future upstream change.

The worker defaults to a **single preview scan** of runs finished in
the last seven days, excluding runs and ledger events newer than five minutes.
It emits JSON lines containing run IDs, eligible estimates, skip reasons, and
a summary. Preview uses read-only transactions and makes no writes. An explicit
`COST_BACKFILL_MODE=apply` enables corrections.

Eligibility requires a terminal run belonging to a Codex agent, one existing
ledger event marked `unpriced` with zero cents, and matching recorded model,
direct OpenAI API billing identity, and per-run token counts. CLI and ACP cache
semantics are checked against the saved result. The worker never substitutes
the agent's current model for the historical model. It skips real prices
(including reported zero), subscriptions, unknown models, session totals,
missing or conflicting usage, missing/duplicate ledger events, and existing
estimates. These cases appear in the preview for review rather than being
guessed. Agents subsequently switched away from Codex are excluded as well.

In apply mode, each correction updates the existing cost event, the run's usage
JSON, lifetime cost total, and applicable current-UTC-month spend counters in one
transaction. Original event dates, token counts, and agent status are preserved.
`resultJson.codexCostBackfill` and a `cost.backfilled` activity entry record the
rate table, original zero/unpriced state, calculated amount, and application
time. Row locks, rechecks and serializable transactions prevent two workers or
repeated scans from charging twice. A failure rolls back that run's entire
correction; earlier committed corrections remain and are skipped on restart.

The corrected ledger is used by Paperclip's cost views and subsequent budget
checks. The worker does not replay historical budget notifications or pause or
resume agents itself. Monthly counters are adjusted by the added cents; they do
not repair any unrelated preexisting accounting discrepancy. Native Paperclip
cost recording also refreshes monthly caches from the ledger.

The worker verifies the required database columns before scanning and stops on
an incompatible schema. It never migrates the database and cannot block a
Paperclip update. After updating Paperclip, review worker logs as well as app
logs. Schema shape checks cannot prove that future accounting semantics remain
the same.

Historical estimates use the standard short-context rates verified on
September 7, 2026, not a reconstructed historical price schedule. They exclude
request-level context premiums, regional uplifts, special tiers, discounts and
tools. Luna runs below half a cent can still display zero due to Paperclip's
per-run cent rounding; they are marked priced and won't be processed again.

#### Railway setup (after deployment approval)

Use the **existing Paperclip service**, with its existing Dockerfile, start
command and `DATABASE_URL`. No separate service or SSH setup is needed.

1. Deploy the approved version of this branch/PR. Set these service variables:

   ```text
   PAPERCLIP_CODEX_BACKFILL_ON_START=1
   COST_BACKFILL_MODE=preview
   COST_BACKFILL_SINCE=2026-09-01T00:00:00Z
   ```

2. Once Paperclip is ready and database migrations have completed, the wrapper
   launches one scan while the app stays available. Review the Railway logs for
   `would_update`, skip reasons, and the final `summary`. Nothing is written in
   preview mode. Choose another start date if needed.
3. To apply the reviewed estimates, change `COST_BACKFILL_MODE=apply` and redeploy
   or restart. The scan updates eligible historical records, prints its summary,
   then exits. It does not run every 15 minutes.
4. After success, remove `PAPERCLIP_CODEX_BACKFILL_ON_START` (or set it to `0`).
   Leaving it enabled only causes another single, idempotent scan on a later
   app startup. Already priced runs are skipped. Future runs are priced by the
   adapter patch regardless of this startup flag.

The startup hook is disabled by default and forces a one-time run even if a
recurring interval was previously configured. A failed scan is logged without
stopping Paperclip. For a manual run inside the deployed container, use
`npm run costs:backfill` with the same variables; it also runs once by default.

The separate `Dockerfile.cost-worker` remains available for standalone jobs.
Railway supports selecting it using `RAILWAY_DOCKERFILE_PATH`, as described in
its [Dockerfile guide](https://docs.railway.com/builds/dockerfiles). It is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | required | Existing Paperclip PostgreSQL connection |
| `PAPERCLIP_CODEX_BACKFILL_ON_START` | disabled | Set `1` to run one scan when Paperclip becomes ready |
| `COST_BACKFILL_MODE` | `preview` | `preview` or `apply` |
| `COST_BACKFILL_SINCE` | rolling seven days | Fixed ISO date, e.g. `2026-09-01T00:00:00Z`; `1970-01-01` scans all history |
| `COST_BACKFILL_INTERVAL_SECONDS` | `0` | Standalone worker only: `0` runs once; optional recurring interval must be at least `60` |
| `COST_BACKFILL_COMPANY_ID` | all companies | Optional company UUID to restrict the scan |

To stop future startup scans, remove the startup flag. To preview without writes,
set the mode to preview. The adapter's
`PAPERCLIP_CODEX_COST_ESTIMATES` switch does not control this independent worker.
Stopping or rolling back the worker image does not undo committed corrections;
their IDs and original values are retained in the audit records for a reviewed
reversal if needed.

Worker checks use a disposable **local** PostgreSQL database named
`paperclip_backfill_test`. The test command rejects remote hosts and never reads
the production `DATABASE_URL`:

```sh
BACKFILL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/paperclip_backfill_test npm run test:backfill
docker build -f Dockerfile.cost-worker -t paperclip-cost-worker-check .
```

---

> A Railway-ready wrapper for [paperclipai/paperclip](https://github.com/paperclipai/paperclip) with a web-based `/setup` page — no CLI access required.

Railway doesn't provide shell access during deployment, so the normal `pnpm paperclipai onboard` flow can't run. This repo solves that by:

1. On first boot, serving a **web-based setup page** at your Railway URL that checks all required env vars and walks you through configuration.
2. Once you click **Launch Paperclip**, the setup page hands off to the real Paperclip server — which automatically runs DB migrations and starts up.
3. You then visit your Railway URL and **sign up** — no CLI needed.

---

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/paperclip-ai-company?referralCode=QXdhdr&utm_medium=integration&utm_source=template&utm_campaign=generic)

### Manual steps

1. **Fork or clone this repo** into your own GitHub account.

2. **Create a new Railway project** and add:
   - A **PostgreSQL** database service (Railway managed)
   - A **new service** pointing at your fork of this repo

3. **Add a volume** to the Paperclip service, mounted at `/paperclip`.

4. **Set these environment variables** on the Paperclip service:

```env
DATABASE_URL="${{Postgres.DATABASE_URL}}"
BETTER_AUTH_SECRET="${{secret(32)}}"
PAPERCLIP_PUBLIC_URL="https://your-app.up.railway.app"
PAPERCLIP_ALLOWED_HOSTNAMES="your-app.up.railway.app"
PAPERCLIP_DEPLOYMENT_MODE="authenticated"
PAPERCLIP_HOME="/paperclip"
HOST="0.0.0.0"
PORT="3100"
NODE_ENV="production"
```

5. **Deploy** — Railway will run `npm start` which serves the setup page.

6. **Open your Railway URL** — you'll see the setup page. Verify all vars are green, then click **Launch Paperclip**.

7. **Sign up** for an account on the Paperclip UI. The first user automatically gets board-level access.

8. **Lock sign-ups**: go back to Railway Variables, add `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, and redeploy.

---

## How it works

```
npm start
  └── scripts/start.mjs
        ├── if SETUP_COMPLETE != "true" AND no /paperclip/.setup_complete file:
        │     serve setup UI on PORT  (/setup)
        │     user clicks "Launch" → writes flag → restarts as paperclip
        └── else:
              write minimal config.json to PAPERCLIP_HOME
              spawn: paperclipai run --yes --no-onboard
```

The setup page auto-polls Railway's env vars by hitting `/setup/status` — each var shows as ✓ Set or ✗ Missing in real time.

---

## Files

```
paperclip-railway/
├── package.json          # installs paperclipai, defines start script
├── scripts/
│   └── start.mjs         # setup server + paperclip launcher
└── README.md
```

---

## After first launch

Once Paperclip is running, this wrapper is transparent — it just passes through to `paperclipai run`. The `/setup` page is bypassed on all subsequent restarts (the flag file persists in the `/paperclip` volume).

---

## Troubleshooting

**Setup page keeps reappearing after redeploy**
→ The `/paperclip` volume wasn't attached. Make sure the volume is mounted at `/paperclip` in Railway's service settings.

**Auth errors / blank screen after login**
→ `PAPERCLIP_PUBLIC_URL` and `PAPERCLIP_ALLOWED_HOSTNAMES` don't match your Railway domain. Update them and redeploy.

**`DATABASE_URL` SSL errors**
→ Add `DATABASE_SSL_REJECT_UNAUTHORIZED=false` to your Railway env vars.

**Paperclip starts but agents can't connect**
→ Make sure `PAPERCLIP_DEPLOYMENT_EXPOSURE=public` is set so the server accepts external connections.

**Agent runs fail with `401 Unauthorized: Missing bearer` (Codex / OpenAI)**
→ The Codex CLI (≥ 0.122) ignores the `OPENAI_API_KEY` env var and only reads credentials from `$CODEX_HOME/auth.json`. On boot, this wrapper seeds `~/.codex/auth.json` from `OPENAI_API_KEY` so Paperclip propagates it to each agent's Codex home. If you set the key after the first deploy, redeploy (or restart) so the file is written, then retry the task.
