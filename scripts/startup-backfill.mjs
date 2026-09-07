import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function createStartupBackfill({ env = process.env, spawnWorker = spawn, log = console.log } = {}) {
  let started = false;
  return () => {
    if (started || env.PAPERCLIP_CODEX_BACKFILL_ON_START !== "1") return;
    started = true;
    log("[codex-cost-backfill] Starting one historical scan; Paperclip remains available.");
    try {
      const child = spawnWorker(process.execPath, [fileURLToPath(new URL("../worker/run.mjs", import.meta.url))], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...env, COST_BACKFILL_INTERVAL_SECONDS: "0" },
      });
      child.on("error", () => log("[codex-cost-backfill] Could not start scan. Paperclip continues running."));
      child.on("exit", code => log(code === 0
        ? "[codex-cost-backfill] Historical scan finished. No recurring worker is running."
        : "[codex-cost-backfill] Scan failed; inspect the preceding summary/error. Paperclip continues running."));
    } catch {
      log("[codex-cost-backfill] Could not start scan. Paperclip continues running.");
    }
  };
}
