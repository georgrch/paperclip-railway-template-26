import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { REQUIRED_COLUMNS, verifySchema, processRun, scanBackfill } from "../worker/backfill.mjs";
import { fixture } from "./backfill-fixture.mjs";

// Never inherit DATABASE_URL: these tests truncate their dedicated local DB.
const testUrl = process.env.BACKFILL_TEST_DATABASE_URL;
if (!testUrl) throw new Error("Set BACKFILL_TEST_DATABASE_URL to an isolated local paperclip_backfill_test database");
const parsed = new URL(testUrl);
if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/paperclip_backfill_test") {
  throw new Error("Refusing to test outside a local database named paperclip_backfill_test");
}
const sql = postgres(testUrl, { max: 5, onnotice: () => {} });
const cutoff = new Date(Date.now() - 5 * 60_000);
before(async () => {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const definitions = Object.entries(columns).map(([column, type]) => `"${column}" ${type}`);
    if (table === "activity_log") definitions.push("id uuid default gen_random_uuid()");
    if (table === "agents") definitions.push("status text default 'idle'");
    await sql.unsafe(`create table if not exists public."${table}" (${definitions.join(", ")})`);
  }
  await verifySchema(sql);
});
beforeEach(async () => {
  await sql.unsafe(`truncate ${Object.keys(REQUIRED_COLUMNS).map(table => `public."${table}"`).join(", ")}`);
});
after(() => sql.end());

async function seed(data = fixture()) {
  const { run, event } = data;
  await sql`insert into public.companies (id, spent_monthly_cents) values (${run.company_id}, 0)`;
  await sql`insert into public.agents (id, company_id, adapter_type, spent_monthly_cents) values (${run.agent_id}, ${run.company_id}, 'codex_local', 0)`;
  await sql`insert into public.agent_runtime_state (agent_id, company_id, total_cost_cents) values (${run.agent_id}, ${run.company_id}, 0)`;
  const { adapter_type, ...record } = run;
  await sql`insert into public.heartbeat_runs ${sql(record)}`;
  await sql`insert into public.cost_events ${sql(event)}`;
  return data;
}

test("preview is read-only; apply updates existing event and accounting once", async () => {
  const { run, event } = await seed();
  assert.equal((await processRun(sql, run.id, { cutoff })).action, "would_update");
  assert.equal((await sql`select cost_cents from cost_events`)[0].cost_cents, 0);
  assert.equal((await sql`select * from activity_log`).length, 0);
  assert.equal((await processRun(sql, run.id, { apply: true, cutoff })).action, "updated");
  assert.equal((await processRun(sql, run.id, { apply: true, cutoff })).action, "skipped");
  const events = await sql`select * from cost_events`;
  assert.equal(events.length, 1);
  assert.equal(events[0].id, event.id);
  assert.equal(events[0].cost_cents, 21);
  assert.equal(events[0].occurred_at.toISOString(), event.occurred_at.toISOString());
  const saved = (await sql`select * from heartbeat_runs`)[0];
  assert.equal(saved.usage_json.costUsd, 0.212);
  assert.equal(saved.result_json.summary, "preserve me");
  assert.equal(saved.result_json.codexCostBackfill.previousCostStatus, "unpriced");
  assert.equal((await sql`select spent_monthly_cents from companies`)[0].spent_monthly_cents, 21);
  assert.equal((await sql`select spent_monthly_cents, status from agents`)[0].status, "idle");
  assert.equal((await sql`select spent_monthly_cents from agents`)[0].spent_monthly_cents, 21);
  assert.equal(Number((await sql`select total_cost_cents from agent_runtime_state`)[0].total_cost_cents), 21);
  assert.equal((await sql`select * from activity_log`).length, 1);
});
test("previous-month costs affect lifetime, not current-month caches", async () => {
  const data = fixture();
  data.event.occurred_at = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0));
  const { run } = await seed(data);
  await processRun(sql, run.id, { apply: true, cutoff });
  assert.equal((await sql`select spent_monthly_cents from companies`)[0].spent_monthly_cents, 0);
  assert.equal((await sql`select spent_monthly_cents from agents`)[0].spent_monthly_cents, 0);
  assert.equal(Number((await sql`select total_cost_cents from agent_runtime_state`)[0].total_cost_cents), 21);
});
test("accounting failure rolls back cost, metadata, and audit together", async () => {
  const { run } = await seed();
  await sql`delete from agent_runtime_state`;
  await assert.rejects(processRun(sql, run.id, { apply: true, cutoff }), /runtime accounting/);
  assert.equal((await sql`select cost_cents from cost_events`)[0].cost_cents, 0);
  assert.equal((await sql`select result_json from heartbeat_runs`)[0].result_json.codexCostBackfill, undefined);
  assert.equal((await sql`select spent_monthly_cents from companies`)[0].spent_monthly_cents, 0);
  assert.equal((await sql`select * from activity_log`).length, 0);
});
test("concurrent workers cannot charge twice", async () => {
  const { run } = await seed();
  const attempts = await Promise.allSettled([
    processRun(sql, run.id, { apply: true, cutoff }), processRun(sql, run.id, { apply: true, cutoff }),
  ]);
  assert.equal(attempts.filter(r => r.status === "fulfilled" && r.value.action === "updated").length, 1);
  for (const result of attempts) if (result.status === "rejected") assert.equal(result.reason.code, "40001");
  assert.equal((await processRun(sql, run.id, { apply: true, cutoff })).action, "skipped");
  assert.equal((await sql`select spent_monthly_cents from companies`)[0].spent_monthly_cents, 21);
});
test("keyset scan passes unknown models and observes scope and age", async () => {
  const unknown = await seed(fixture({ model: "future-model" }));
  const known = await seed(fixture({ model: "gpt-5.6-luna" }));
  const recent = fixture();
  recent.run.finished_at = new Date();
  await seed(recent);
  const results = [];
  const summary = await scanBackfill(sql, { since: new Date(Date.now() - 86_400_000), batchSize: 1, onResult: row => results.push(row) });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.would_update, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.costCents, 1);
  assert.ok(results.some(row => row.runId === unknown.run.id && row.action === "skipped"));
  const scoped = await scanBackfill(sql, { since: new Date(0), companyId: known.run.company_id });
  assert.equal(scoped.scanned, 1);
});
test("a schema change stops the worker before any write", async () => {
  await seed();
  await sql`alter table cost_events rename column cost_status to changed_status`;
  try {
    await assert.rejects(scanBackfill(sql, { since: new Date(0), apply: true }), /Schema compatibility/);
    assert.equal((await sql`select cost_cents from cost_events`)[0].cost_cents, 0);
  } finally {
    await sql`alter table cost_events rename column changed_status to cost_status`;
  }
});

test("sub-cent Luna runs are marked priced once even when rounded cost is zero", async () => {
  const data = fixture({ model: "gpt-5.6-luna" });
  Object.assign(data.run.usage_json, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 });
  data.run.result_json.usage = { inputTokens: 100, cachedReadTokens: 0, outputTokens: 10 };
  Object.assign(data.event, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 });
  const { run } = await seed(data);
  const result = await processRun(sql, run.id, { cutoff, apply: true });
  assert.equal(result.action, "updated");
  assert.equal(result.costCents, 0);
  assert.ok(result.costUsd > 0);
  assert.equal((await processRun(sql, run.id, { cutoff, apply: true })).action, "skipped");
  assert.equal((await sql`select cost_status from cost_events`)[0].cost_status, "reported");
});

test("pagination retains database microseconds", async () => {
  const { run } = await seed();
  await sql`update heartbeat_runs set finished_at = date_trunc('second', finished_at) + interval '0.000123 second' where id = ${run.id}`;
  let seen = 0;
  const result = await scanBackfill(sql, {
    since: new Date(0), batchSize: 1,
    onResult: () => { if (++seen > 1) throw new Error("pagination repeated a record"); },
  });
  assert.equal(result.scanned, 1);
});
