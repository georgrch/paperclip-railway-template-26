import { estimateCodexCost } from "../scripts/codex-costs.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const missing = value => value === null || value === undefined;

// Only use persisted per-run evidence. Today's agent model/configuration is
// never a substitute for the model or billing identity recorded at run time.
export function planBackfill(run, events) {
  if (run.adapter_type !== "codex_local") return { reason: "not a Codex agent" };
  if (!["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) {
    return { reason: "run is not terminal" };
  }
  if (events.length !== 1) return { reason: events.length ? "multiple ledger events" : "no ledger event; manual review required" };
  const event = events[0];
  if (event.company_id !== run.company_id || event.agent_id !== run.agent_id) return { reason: "ledger scope mismatch" };
  if (event.cost_status !== "unpriced" || event.cost_cents !== 0) return { reason: "ledger already priced" };
  const usage = object(run.usage_json);
  const result = object(run.result_json);
  if (result.codexCostBackfill || result.codexCostEstimate) return { reason: "estimate already recorded" };
  for (const value of [usage, result]) {
    if (![value.costUsd, value.cacheAdjustedCostUsd, value.cost_usd].every(missing)) {
      return { reason: "run already has a cost" };
    }
  }
  if (usage.usageSource !== "per_run") return { reason: "usage is not explicitly per-run" };
  if (usage.provider !== "openai" || usage.biller !== "openai" || usage.billingType !== "metered_api"
      || event.provider !== "openai" || event.biller !== "openai" || event.billing_type !== "metered_api") {
    return { reason: "not a recorded direct OpenAI API run" };
  }
  if (usage.model !== event.model) return { reason: "run and ledger models disagree" };
  for (const [jsonKey, column] of [["inputTokens", "input_tokens"], ["cachedInputTokens", "cached_input_tokens"], ["outputTokens", "output_tokens"]]) {
    if (usage[jsonKey] !== event[column]) return { reason: "run and ledger token counts disagree" };
    const rawKey = `raw${jsonKey[0].toUpperCase()}${jsonKey.slice(1)}`;
    if (!missing(usage[rawKey]) && usage[rawKey] !== usage[jsonKey]) return { reason: "raw and normalized token counts disagree" };
  }
  const estimate = estimateCodexCost({
    usage, usageBasis: "per_run", model: usage.model,
    provider: usage.provider, biller: usage.biller, billingType: "api", resultJson: result,
  });
  if (missing(estimate.costUsd)) return estimate;
  const costCents = Math.round(estimate.costUsd * 100);
  if (!Number.isSafeInteger(costCents) || costCents > 2_147_483_647) return { reason: "estimate exceeds ledger range" };
  return {
    ...estimate, costCents, eventId: event.id, model: usage.model,
    metadata: {
      source: "railway-codex-backfill-v1", pricingDate: "2026-09-07",
      engine: estimate.engine, ratesUsdPerMillion: estimate.rates,
      costUsd: estimate.costUsd, costCents, eventId: event.id,
      previousCostCents: event.cost_cents, previousCostStatus: event.cost_status,
      limitations: "Current short-context standard-rate estimate applied to historical per-run tokens. Regional uplifts, request-level long context, tiers, discounts, cache writes and tools are not reconciled.",
    },
  };
}
