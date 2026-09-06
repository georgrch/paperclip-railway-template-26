// Standard OpenAI API rates, USD / million tokens; checked 2026-09-06.
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
// https://developers.openai.com/api/docs/models/gpt-6-astra
// These are estimates, NOT invoice reconciliation or subscription quota usage.
export const PRICES = Object.freeze({
  "gpt-5.6-sol": Object.freeze({ input: 4, cached: 0.4, output: 20 }),
  "gpt-5.6-terra": Object.freeze({ input: 2, cached: 0.2, output: 12 }),
  "gpt-6-astra": Object.freeze({ input: 10, cached: 1, output: 50 }),
});
// The installer verifies each installed runtime's token semantics independently.
export const VERIFIED_ENGINES = { cli: true, acp: true };

export function estimateCodexCost(result) {
  if (result.costUsd != null || result.cacheAdjustedCostUsd != null) {
    return { reason: "upstream cost already present" };
  }
  if (result.billingType !== "api" || result.provider !== "openai" || result.biller !== "openai") {
    return { reason: "not a direct OpenAI API run" };
  }
  if (result.usageBasis !== "per_run") return { reason: "usage is not explicitly per-run" };
  const rates = Object.hasOwn(PRICES, result.model) ? PRICES[result.model] : null;
  if (!rates) return { reason: "model has no verified price entry" };
  const { inputTokens, outputTokens, cachedInputTokens = 0 } = result.usage ?? {};
  if (![inputTokens, outputTokens, cachedInputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
    return { reason: "missing or invalid token usage" };
  }
  let uncachedInputTokens;
  let engine;
  if (typeof result.resultJson?.stdout === "string") {
    if (!VERIFIED_ENGINES.cli) return { reason: "CLI usage semantics changed; compatibility review needed" };
    // Codex CLI input_tokens INCLUDES cached_input_tokens.
    if (cachedInputTokens > inputTokens) return { reason: "invalid CLI cached token count" };
    uncachedInputTokens = inputTokens - cachedInputTokens;
    engine = "cli";
  } else {
    if (!VERIFIED_ENGINES.acp) return { reason: "ACP usage semantics changed; compatibility review needed" };
    // codex-acp 1.10.0 subtracts cached input before reporting prompt usage.
    // Verify the detailed ACP result agrees; never infer semantics by size.
    const detail = result.resultJson?.usage;
    if (!detail || detail.inputTokens !== inputTokens || detail.outputTokens !== outputTokens
        || (detail.cachedReadTokens ?? 0) !== cachedInputTokens || (detail.cachedWriteTokens ?? 0) !== 0) {
      return { reason: "missing or unsupported ACP token breakdown; CLI engine is an alternative" };
    }
    uncachedInputTokens = inputTokens;
    engine = "acp";
  }
  if (uncachedInputTokens + cachedInputTokens + outputTokens === 0) return { reason: "no recorded token usage" };
  // output_tokens already includes reported reasoning usage; do not add it again.
  const costUsd = (uncachedInputTokens * rates.input
    + cachedInputTokens * rates.cached + outputTokens * rates.output) / 1_000_000;
  return { costUsd, rates, engine };
}

export async function withCodexCostEstimate(result, ctx, env = process.env) {
  if (env.PAPERCLIP_CODEX_COST_ESTIMATES === "0") return result;
  const estimate = estimateCodexCost(result);
  // A logging problem must never turn completed agent work into a failed run.
  const log = async message => {
    try { await ctx.onLog?.("stderr", `[codex-cost-estimate] ${message}\n`); } catch {}
  };
  if (estimate.costUsd == null) {
    if (result.billingType === "api" && result.costUsd == null && result.cacheAdjustedCostUsd == null) {
      await log(`Unpriced: ${estimate.reason}.`);
    }
    return result;
  }
  await log(`USD ${estimate.costUsd.toFixed(6)} (${result.model}, standard-rate estimate; not reconciled billing).`);
  return {
    ...result,
    costUsd: estimate.costUsd,
    resultJson: {
      ...result.resultJson,
      codexCostEstimate: {
        source: "railway-standard-rate-estimate-v1",
        pricingDate: "2026-09-06",
        engine: estimate.engine,
        ratesUsdPerMillion: estimate.rates,
        costUsd: estimate.costUsd,
        limitations: "Run-level totals cannot identify per-request long-context premiums, service tiers, discounts, or unreported usage. Tool charges excluded.",
      },
    },
  };
}
