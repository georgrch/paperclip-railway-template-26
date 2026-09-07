import postgres from "postgres";
import { setTimeout } from "node:timers/promises";
import { scanBackfill } from "./backfill.mjs";

const env = process.env;
const mode = env.COST_BACKFILL_MODE ?? "preview";
if (!["preview", "apply"].includes(mode)) throw new Error("COST_BACKFILL_MODE must be preview or apply");
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const interval = Number(env.COST_BACKFILL_INTERVAL_SECONDS ?? 900);
if (!Number.isSafeInteger(interval) || interval < 0 || (interval > 0 && interval < 60)) {
  throw new Error("COST_BACKFILL_INTERVAL_SECONDS must be 0 (one scan) or at least 60");
}
const fixedSince = env.COST_BACKFILL_SINCE ? new Date(env.COST_BACKFILL_SINCE) : null;
if (fixedSince && !Number.isFinite(fixedSince.getTime())) throw new Error("COST_BACKFILL_SINCE must be an ISO date");
const companyId = env.COST_BACKFILL_COMPANY_ID || null;
if (companyId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
  throw new Error("COST_BACKFILL_COMPANY_ID must be a UUID");
}
let sql;
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => controller.abort());
try {
  sql = postgres(env.DATABASE_URL, {
    max: 2, connect_timeout: 10,
    connection: { application_name: "paperclip-cost-backfill", statement_timeout: 30_000, lock_timeout: 5_000 },
  });
  do {
    const since = fixedSince ?? new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const summary = await scanBackfill(sql, {
      apply: mode === "apply", since, companyId,
      onResult: result => console.log(JSON.stringify({ type: "run", ...result })),
    });
    console.log(JSON.stringify({ type: "summary", ...summary }));
    if (!interval || controller.signal.aborted) break;
    try { await setTimeout(interval * 1000, undefined, { signal: controller.signal }); }
    catch (error) { if (error.name !== "AbortError") throw error; }
  } while (!controller.signal.aborted);
} catch (error) {
  // Database errors may contain query parameters or connection information.
  // Emit only a code; inspect schema compatibility through the preview tool.
  console.error(JSON.stringify({ type: "error", code: error.code ?? "BACKFILL_STOPPED", message: "Scan stopped; no partial transaction is retained. Check database access and schema compatibility before retrying." }));
  process.exitCode = 1;
} finally {
  await sql?.end({ timeout: 5 });
}
