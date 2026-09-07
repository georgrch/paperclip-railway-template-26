import test from "node:test";
import assert from "node:assert/strict";
import { planBackfill } from "../worker/estimate.mjs";
import { fixture } from "./backfill-fixture.mjs";

for (const engine of ["cli", "acp"]) {
  for (const [model, usd, cents] of [["gpt-5.6-sol", 0.212, 21], ["gpt-5.6-terra", 0.116, 12], ["gpt-5.6-luna", 0.0116, 1], ["gpt-6-astra", 0.53, 53]]) {
    test(`historical ${engine} ${model}: prices persisted usage`, () => {
      const { run, event } = fixture({ engine, model });
      const plan = planBackfill(run, [event]);
      assert.equal(plan.costUsd, usd);
      assert.equal(plan.costCents, cents);
      assert.equal(plan.engine, engine);
    });
  }
}
const cases = {
  "paid ledger": ({ event }) => { event.cost_cents = 30; },
  "reported zero ledger": ({ event }) => { event.cost_status = "reported"; },
  "upstream zero": ({ run }) => { run.usage_json.costUsd = 0; },
  "upstream cache adjusted cost": ({ run }) => { run.usage_json.cacheAdjustedCostUsd = 2; },
  "unreconciled existing estimate": ({ run }) => { run.result_json.codexCostEstimate = {}; },
  "unknown model": ({ run, event }) => { run.usage_json.model = event.model = "future-model"; },
  "model disagreement": ({ event }) => { event.model = "gpt-6-astra"; },
  "subscription": ({ run, event }) => { run.usage_json.billingType = event.billing_type = "subscription_included"; },
  "unknown historical billing": ({ run }) => { delete run.usage_json.biller; },
  "session totals": ({ run }) => { run.usage_json.usageSource = "session_delta"; },
  "missing ACP breakdown": ({ run }) => { delete run.result_json.usage; },
  "cache writes": ({ run }) => { run.result_json.usage.cachedWriteTokens = 200; },
  "ledger usage mismatch": ({ event }) => { event.input_tokens++; },
  "raw usage mismatch": ({ run }) => { run.usage_json.rawInputTokens = 999; },
  "company mismatch": ({ event }) => { event.company_id = "another-company"; },
  "agent mismatch": ({ event }) => { event.agent_id = "another-agent"; },
  "non-Codex agent": ({ run }) => { run.adapter_type = "claude_local"; },
  "active run": ({ run }) => { run.status = "running"; },
};
for (const [name, change] of Object.entries(cases)) {
  test(`skips ${name}`, () => {
    const data = fixture();
    change(data);
    const before = structuredClone(data);
    assert.equal(planBackfill(data.run, [data.event]).costUsd, undefined);
    assert.deepEqual(data, before);
  });
}
test("does not guess when the ledger event is missing or duplicated", () => {
  const { run, event } = fixture();
  assert.match(planBackfill(run, []).reason, /no ledger event/);
  assert.match(planBackfill(run, [event, event]).reason, /multiple/);
});
