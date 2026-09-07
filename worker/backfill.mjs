import { planBackfill } from "./estimate.mjs";
import { setTimeout } from "node:timers/promises";

// A schema change stops this independent worker, never the Paperclip service.
// Match only the columns used below; additive upstream columns are compatible.
export const REQUIRED_COLUMNS = {
  heartbeat_runs: { id: "uuid", company_id: "uuid", agent_id: "uuid", status: "text", finished_at: "timestamp with time zone", usage_json: "jsonb", result_json: "jsonb", updated_at: "timestamp with time zone" },
  cost_events: { id: "uuid", company_id: "uuid", agent_id: "uuid", heartbeat_run_id: "uuid", provider: "text", biller: "text", billing_type: "text", cost_status: "text", model: "text", input_tokens: "integer", cached_input_tokens: "integer", output_tokens: "integer", cost_cents: "integer", occurred_at: "timestamp with time zone", created_at: "timestamp with time zone" },
  agents: { id: "uuid", company_id: "uuid", adapter_type: "text", spent_monthly_cents: "integer", updated_at: "timestamp with time zone" },
  companies: { id: "uuid", spent_monthly_cents: "integer", updated_at: "timestamp with time zone" },
  agent_runtime_state: { agent_id: "uuid", company_id: "uuid", total_cost_cents: "bigint", updated_at: "timestamp with time zone" },
  activity_log: { company_id: "uuid", actor_type: "text", actor_id: "text", action: "text", entity_type: "text", entity_id: "text", agent_id: "uuid", run_id: "uuid", details: "jsonb" },
};

export async function verifySchema(sql) {
  const columns = await sql`
    select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' and table_name in ${sql(Object.keys(REQUIRED_COLUMNS))}`;
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    for (const [column, type] of Object.entries(required)) {
      if (!columns.some(row => row.table_name === table && row.column_name === column && row.data_type === type)) {
        throw new Error(`Schema compatibility review required: public.${table}.${column} must be ${type}`);
      }
    }
  }
}

export async function processRun(sql, id, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await transactRun(sql, id, options); }
    catch (error) {
      if (attempt >= 2 || !["40001", "40P01"].includes(error.code)) throw error;
      await setTimeout(50 * (attempt + 1));
    }
  }
}

async function transactRun(sql, id, { apply = false, cutoff, companyId = null } = {}) {
  if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new Error("A valid completion cutoff is required");
  return sql.begin(apply ? "isolation level serializable" : "isolation level repeatable read read only", async tx => {
    const rows = await tx`
      select r.id, r.company_id, r.agent_id, r.status, r.finished_at, r.usage_json, r.result_json, a.adapter_type
      from public.heartbeat_runs r
      join public.agents a on a.id = r.agent_id and a.company_id = r.company_id
      where r.id = ${id} and r.finished_at <= ${cutoff}
        and (${companyId}::uuid is null or r.company_id = ${companyId}::uuid)
      ${apply ? tx`for update of r` : tx``}`;
    const run = rows[0];
    if (!run) return { runId: id, action: "skipped", reason: "run changed, too recent, or outside company scope" };
    const events = await tx`
      select * from public.cost_events where heartbeat_run_id = ${id}
      ${apply ? tx`for update` : tx``}`;
    if (events.some(event => new Date(event.created_at) > cutoff)) {
      return { runId: id, action: "skipped", reason: "ledger event is too recent" };
    }
    const plan = planBackfill(run, events);
    if (plan.costUsd == null) return { runId: id, action: "skipped", reason: plan.reason };
    const report = { runId: id, companyId: run.company_id, eventId: plan.eventId, model: plan.model, engine: plan.engine, costUsd: plan.costUsd, costCents: plan.costCents };
    if (!apply) return { ...report, action: "would_update" };

    // The row locks plus serializable transaction and recheck make retries and
    // overlapping workers safe. We edit the original event, never insert one.
    const changed = await tx`
      update public.cost_events set cost_cents = ${plan.costCents}, cost_status = 'reported'
      where id = ${plan.eventId} and cost_cents = 0 and cost_status = 'unpriced' returning id`;
    if (changed.length !== 1) throw new Error("Ledger changed during backfill; retry the scan");
    const appliedAt = new Date().toISOString();
    const metadata = { ...plan.metadata, appliedAt };
    await tx`
      update public.heartbeat_runs
      set usage_json = coalesce(usage_json, '{}'::jsonb) || ${tx.json({ costUsd: plan.costUsd, cacheAdjustedCostUsd: plan.costUsd, costStatus: "reported" })}::jsonb,
          result_json = coalesce(result_json, '{}'::jsonb) || ${tx.json({ codexCostBackfill: metadata })}::jsonb,
          updated_at = now()
      where id = ${id}`;

    // Preserve token counters, agent status and historical event timestamps.
    // Add only the missing cost; lifetime spend includes previous months, while
    // cached monthly spend only receives events from the current UTC month.
    const month = new Date(appliedAt);
    const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const occurredAt = new Date(events[0].occurred_at);
    if (occurredAt >= monthStart && occurredAt < monthEnd) {
      await tx`update public.agents set spent_monthly_cents = spent_monthly_cents + ${plan.costCents}, updated_at = now()
        where id = ${run.agent_id} and company_id = ${run.company_id}`;
      await tx`update public.companies set spent_monthly_cents = spent_monthly_cents + ${plan.costCents}, updated_at = now()
        where id = ${run.company_id}`;
    }
    const runtime = await tx`
      update public.agent_runtime_state set total_cost_cents = total_cost_cents + ${plan.costCents}, updated_at = now()
      where agent_id = ${run.agent_id} and company_id = ${run.company_id} returning agent_id`;
    if (runtime.length !== 1) throw new Error("Missing agent runtime accounting row; review before backfilling");
    await tx`
      insert into public.activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details)
      values (${run.company_id}, 'system', 'railway-codex-cost-worker', 'cost.backfilled', 'heartbeat_run', ${id}, ${run.agent_id}, ${id}, ${tx.json(metadata)})`;
    return { ...report, action: "updated" };
  });
}

export async function scanBackfill(sql, { apply = false, since, companyId = null, batchSize = 100, onResult = () => {} } = {}) {
  if (!(since instanceof Date) || !Number.isFinite(since.getTime())) throw new Error("A valid scan start date is required");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("batchSize must be 1–1000");
  await verifySchema(sql);
  const cutoff = new Date(Date.now() - 5 * 60_000);
  const summary = { mode: apply ? "apply" : "preview", since: since.toISOString(), cutoff: cutoff.toISOString(), scanned: 0, updated: 0, would_update: 0, skipped: 0, costCents: 0, costUsd: 0 };
  let cursorDate = since.toISOString();
  let cursorId = "00000000-0000-0000-0000-000000000000";
  while (true) {
    // A stable keyset cursor passes skipped records too; unknown models cannot
    // starve later eligible runs. No prompts, output or credentials are logged.
    const runs = await sql`
      select r.id, r.finished_at::text as cursor_time from public.heartbeat_runs r
      join public.agents a on a.id = r.agent_id and a.company_id = r.company_id
      where a.adapter_type = 'codex_local'
        and r.status in ('succeeded', 'failed', 'timed_out', 'cancelled')
        and r.finished_at <= ${cutoff}
        and (r.finished_at, r.id) > (${cursorDate}::text::timestamptz, ${cursorId}::uuid)
        and (${companyId}::uuid is null or r.company_id = ${companyId}::uuid)
        and coalesce(r.usage_json->>'costStatus', 'unpriced') = 'unpriced'
      order by r.finished_at, r.id limit ${batchSize}`;
    if (!runs.length) break;
    for (const run of runs) {
      const result = await processRun(sql, run.id, { apply, cutoff, companyId });
      summary.scanned++;
      summary[result.action]++;
      summary.costCents += result.costCents ?? 0;
      summary.costUsd += result.costUsd ?? 0;
      await onResult(result);
    }
    // Keep PostgreSQL's microseconds; JS Date truncation can repeat a page.
    cursorDate = runs.at(-1).cursor_time;
    cursorId = runs.at(-1).id;
  }
  return summary;
}
