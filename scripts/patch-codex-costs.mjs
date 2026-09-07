import { readFile, writeFile, rename, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_VERSION = "2026.831.1";
const marker = "// paperclip-railway: codex-cost-estimate-v1";

export function patchSource(source, version) {
  const importLine = 'import { withCodexCostEstimate } from "./railway-codex-costs.mjs";\n';
  const wrapper = `\n${marker}\nexport async function execute(ctx) {\n    return withCodexCostEstimate(await executeWithoutRailwayCostEstimate(ctx), ctx);\n}\n`;
  // Verify a previously patched file too: idempotence must not hide drift.
  if (source.includes(marker)) {
    if (!source.startsWith(importLine) || !source.endsWith(wrapper)
        || !source.includes("async function executeWithoutRailwayCostEstimate(ctx) {")) {
      throw new Error("Patched adapter has drifted; refusing to modify it.");
    }
    return source;
  }
  if (source.split("export async function execute(ctx) {").length !== 2
      || source.includes("executeWithoutRailwayCostEstimate")) {
    throw new Error(`Codex adapter ${version} export shape changed; compatibility review needed.`);
  }
  return importLine + source.replace("export async function execute(ctx) {", "async function executeWithoutRailwayCostEstimate(ctx) {") + wrapper;
}

export async function installPatch() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  // Locate packages through Node's search paths without require-loading their
  // ESM-only exports or starting the server. Supports nested npm dependencies.
  async function locate(name, from) {
    for (const base of createRequire(from).resolve.paths(name) ?? []) {
      const candidate = join(base, name, "package.json");
      try { await access(candidate); return candidate; } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Cannot find installed ${name}. Run npm ci first.`);
  }
  const cliPackage = await locate("paperclipai", join(root, "package.json"));
  const serverPackage = await locate("@paperclipai/server", cliPackage);
  const adapterPackage = await locate("@paperclipai/adapter-codex-local", serverPackage);
  const utilsPackage = await locate("@paperclipai/adapter-utils", adapterPackage);
  const acpPackage = await locate("@agentclientprotocol/codex-acp", adapterPackage);
  const acpUtils = await readFile(join(dirname(utilsPackage), "dist/acpx-engine/execute.js"), "utf8");
  const acpSource = await readFile(join(dirname(acpPackage), "dist/index.js"), "utf8");
  const acpVerified = /inputTokens:\s*usage\.inputTokens\s*-\s*usage\.cachedInputTokens/.test(acpSource)
    && /inputTokens:\s*inputTokens\s*\+\s*cachedWriteTokens/.test(acpUtils)
    && /cachedInputTokens:\s*cachedReadTokens/.test(acpUtils);
  const dir = join(dirname(adapterPackage), "dist/server");
  const pkg = JSON.parse(await readFile(join(dir, "../../package.json"), "utf8"));
  const parser = await readFile(join(dir, "parse.js"), "utf8");
  const cliVerified = /usage\.inputTokens\s*=\s*asNumber\(usageObj\.input_tokens/.test(parser)
    && /usage\.cachedInputTokens\s*=\s*asNumber\(usageObj\.cached_input_tokens/.test(parser);
  const target = join(dir, "execute.js");
  const source = await readFile(target, "utf8");
  const patched = patchSource(source, pkg.version);
  const helper = (await readFile(join(root, "scripts/codex-costs.mjs"), "utf8"))
    .replace("export const VERIFIED_ENGINES = { cli: true, acp: true };",
      `export const VERIFIED_ENGINES = ${JSON.stringify({ cli: cliVerified, acp: acpVerified })};`);
  await writeFile(join(dir, "railway-codex-costs.mjs"), helper);
  await writeFile(`${target}.railway-tmp`, patched);
  await rename(`${target}.railway-tmp`, target);
  console.log(`[codex-cost-estimate] Patched and verified adapter ${pkg.version}.`);
  if (!cliVerified || !acpVerified) console.warn(`[codex-cost-estimate] Compatibility warning: CLI=${cliVerified}, ACP=${acpVerified}. Unverified lanes will remain unpriced.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await installPatch(); } catch (error) {
    console.warn(`[codex-cost-estimate] PATCH SKIPPED: ${error.message} Paperclip can continue updating; review cost reporting.`);
  }
}
