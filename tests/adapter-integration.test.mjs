import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { patchSource, SUPPORTED_VERSION } from "../scripts/patch-codex-costs.mjs";
import { withCodexCostEstimate } from "../scripts/codex-costs.mjs";

test("released ACP usage folding prices cache correctly", async () => {
  const { summarizeAcpxTurnUsage } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
  const folded = summarizeAcpxTurnUsage({
    preStatus: null, postStatus: null, eventCostUsd: null,
    eventBreakdown: { inputTokens: 20_000, cachedReadTokens: 80_000, outputTokens: 5_000, thoughtTokens: 1_000 },
  });
  const priced = await withCodexCostEstimate({
    usage: folded.usage, usageBasis: "per_run", costUsd: folded.costUsd,
    model: "gpt-5.6-sol", provider: "openai", biller: "openai", billingType: "api",
    resultJson: { usage: folded.usageDetail },
  }, {}, {});
  assert.equal(priced.costUsd, 0.212);
  assert.equal(priced.resultJson.codexCostEstimate.engine, "acp");
});

test("released adapter: parse JSONL, wrap result, repeat patch safely", async (t) => {
  const serverIndex = import.meta.resolve("@paperclipai/adapter-codex-local/server");
  const { parseCodexJsonl } = await import(new URL("./parse.js", serverIndex));
  const source = await readFile(new URL("./execute.js", serverIndex), "utf8");
  let patched;
  try { patched = patchSource(source, SUPPORTED_VERSION); } catch (error) {
    t.skip(`Upstream adapter changed: ${error.message}`);
    return;
  }
  assert.equal(patchSource(patched, SUPPORTED_VERSION), patched);
  assert.throws(() => patchSource(patched + "\n// drift", SUPPORTED_VERSION), /drifted/);
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "test-thread" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 5_000 } }),
  ].join("\n"));
  assert.equal(parsed.usageBasis, "per_run");
  assert.equal(parsed.usage.cachedInputTokens, 80_000);
  // Exercise the exact installed wrapper with a fake delegate. No agent, API,
  // auth files, production database, or network is involved.
  const wrapper = patched.slice(patched.lastIndexOf("// paperclip-railway: codex-cost-estimate-v1"));
  const helperUrl = new URL("../scripts/codex-costs.mjs", import.meta.url).href;
  const harness = `import { withCodexCostEstimate } from ${JSON.stringify(helperUrl)};
    async function executeWithoutRailwayCostEstimate(ctx) { return ctx.fakeResult; }
    ${wrapper}`;
  const { execute } = await import(`data:text/javascript;base64,${Buffer.from(harness).toString("base64")}`);
  const priced = await execute({ fakeResult: {
    usage: parsed.usage, usageBasis: parsed.usageBasis,
    model: "gpt-5.6-sol", provider: "openai", biller: "openai", billingType: "api",
    costUsd: null, resultJson: { stdout: "fixture" }, sessionId: parsed.sessionId,
  } });
  assert.equal(priced.costUsd, 0.212);
  assert.equal(priced.sessionId, "test-thread");
});
