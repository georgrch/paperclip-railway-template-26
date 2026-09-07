import { randomUUID } from "node:crypto";

export function fixture({ engine = "acp", model = "gpt-5.6-sol" } = {}) {
  const usage = {
    inputTokens: engine === "acp" ? 20_000 : 100_000,
    cachedInputTokens: 80_000, outputTokens: 5_000,
    provider: "openai", biller: "openai", billingType: "metered_api",
    usageSource: "per_run", model, costStatus: "unpriced",
  };
  const run = {
    id: randomUUID(), company_id: randomUUID(), agent_id: randomUUID(),
    adapter_type: "codex_local", status: "succeeded", usage_json: usage,
    finished_at: new Date(Date.now() - 60 * 60_000),
    result_json: engine === "cli" ? { stdout: "fixture", summary: "preserve me" } : {
      requestedModel: model, summary: "preserve me",
      usage: { inputTokens: 20_000, cachedReadTokens: 80_000, outputTokens: 5_000 },
    },
  };
  const event = {
    id: randomUUID(), heartbeat_run_id: run.id, company_id: run.company_id, agent_id: run.agent_id,
    provider: "openai", biller: "openai", billing_type: "metered_api", model,
    cost_cents: 0, cost_status: "unpriced", input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens, output_tokens: usage.outputTokens,
    occurred_at: run.finished_at, created_at: run.finished_at,
  };
  return { run, event };
}
