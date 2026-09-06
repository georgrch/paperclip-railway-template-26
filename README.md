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
   supported model (`gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-6-astra`). Both CLI
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
Historical runs are unchanged; there is no automatic backfill.

If an ACP run lacks its required token breakdown, it remains unpriced with an
explanatory log; explicitly setting `"engine": "cli"` is an alternative.
Pricing is an explicit three-model table in
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
