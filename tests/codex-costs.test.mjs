import test from "node:test";
import assert from "node:assert/strict";
import { estimateCodexCost, withCodexCostEstimate } from "../scripts/codex-costs.mjs";
import { patchSource } from "../scripts/patch-codex-costs.mjs";

const run = (overrides = {}) => ({
  provider: "openai", biller: "openai", billingType: "api", model: "gpt-5.6-sol",
  costUsd: null, usageBasis: "per_run",
  usage: { inputTokens: 100_000, cachedInputTokens: 80_000, outputTokens: 5_000 },
  resultJson: { stdout: "existing output" },
  ...overrides,
});

test("Sol charges cache once and returns USD, not cents", () => {
  assert.equal(estimateCodexCost(run()).costUsd, 0.212);
});
test("Terra, Luna and Astra rates", () => {
  assert.equal(estimateCodexCost(run({ model: "gpt-5.6-terra" })).costUsd, 0.116);
  assert.equal(estimateCodexCost(run({ model: "gpt-5.6-luna" })).costUsd, 0.0116);
  assert.equal(estimateCodexCost(run({ model: "gpt-6-astra" })).costUsd, 0.53);
});
test("non-cached and fully cached input", () => {
  assert.equal(estimateCodexCost(run({ usage: { inputTokens: 1_000, outputTokens: 100 } })).costUsd, 0.006);
  assert.equal(estimateCodexCost(run({ usage: { inputTokens: 1_000, cachedInputTokens: 1_000, outputTokens: 0 } })).costUsd, 0.0004);
});
test("reasoning breakdown is not added to total output a second time", () => {
  const r = run();
  r.usage.reasoningTokens = 2_000;
  assert.equal(estimateCodexCost(r).costUsd, 0.212);
});
test("ACP input already excludes cache reads", () => {
  const r = run({
    usage: { inputTokens: 20_000, cachedInputTokens: 80_000, outputTokens: 5_000 },
    resultJson: { usage: { inputTokens: 20_000, cachedReadTokens: 80_000, outputTokens: 5_000, thoughtTokens: 1_000 } },
  });
  assert.equal(estimateCodexCost(r).costUsd, 0.212);
  assert.equal(estimateCodexCost(r).engine, "acp");
});
for (const [name, overrides] of Object.entries({
  subscription: { billingType: "subscription" },
  openrouter: { biller: "openrouter" },
  otherProvider: { provider: "other" },
  unknownBiller: { biller: undefined },
  unknownModel: { model: "unknown" },
  inheritedPropertyModel: { model: "toString" },
  cumulativeUsage: { usageBasis: "cumulative" },
  unspecifiedUsageBasis: { usageBasis: undefined },
  acpUsage: { resultJson: { usage: { inputTokens: 20_000, cachedReadTokens: 80_000 } } },
  upstreamCost: { costUsd: 1.23 },
  upstreamZero: { costUsd: 0 },
  cacheAdjustedCost: { cacheAdjustedCostUsd: 0.1 },
  noUsage: { usage: undefined },
  noTokens: { usage: { inputTokens: 0, outputTokens: 0 } },
  invalidCache: { usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 1 } },
  negativeUsage: { usage: { inputTokens: -1, outputTokens: 1 } },
  nanUsage: { usage: { inputTokens: NaN, outputTokens: 1 } },
})) {
  test(`leaves ${name} unmodified`, async () => {
    const original = run(overrides);
    assert.equal(await withCodexCostEstimate(original, {}, {}), original);
  });
}
test("preserves run data and records estimation metadata", async () => {
  const original = run({ errorCode: "some_error", sessionId: "session-1" });
  const logs = [];
  const priced = await withCodexCostEstimate(original, { onLog: (...args) => logs.push(args) }, {});
  assert.equal(priced.costUsd, 0.212);
  assert.equal(priced.errorCode, original.errorCode);
  assert.equal(priced.sessionId, original.sessionId);
  assert.equal(priced.usage, original.usage);
  assert.equal(priced.resultJson.stdout, "existing output");
  assert.equal(priced.resultJson.codexCostEstimate.source, "railway-standard-rate-estimate-v1");
  assert.equal(original.costUsd, null);
  assert.match(logs[0][1], /standard-rate estimate/);
});
test("kill switch preserves result", async () => {
  const original = run();
  assert.equal(await withCodexCostEstimate(original, {}, { PAPERCLIP_CODEX_COST_ESTIMATES: "0" }), original);
});
test("log failures cannot break completed work", async () => {
  const priced = await withCodexCostEstimate(run(), { onLog() { throw new Error("logging unavailable"); } }, {});
  assert.equal(priced.costUsd, 0.212);
});
test("accepts compatible future versions; rejects changed exports before writing", () => {
  assert.match(patchSource("export async function execute(ctx) { return ctx; }", "2099.1.0"), /withCodexCostEstimate/);
  assert.throws(() => patchSource("changed", "2026.831.1"), /export shape changed/);
  assert.throws(() => patchSource("// paperclip-railway: codex-cost-estimate-v1", "2026.831.1"), /drifted/);
});
