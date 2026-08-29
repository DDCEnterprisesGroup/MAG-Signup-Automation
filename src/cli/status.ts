import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchCompatibleBrowser } from "../browser/browser-launch.js";
import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import { buildOperationsStatus } from "../operations/status.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const workerWasRunning = await readFile(`${config.workbookPath}.lock`, "utf8").then(() => true).catch(() => false);
  const workbook = new WorkbookStore(config.workbookPath);
  await workbook.open();
  try {
    const status = buildOperationsStatus(
      workbook.getPeople(),
      workbook.getSites(),
      workbook.getAttempts(),
      workbook.getSiteIssues(),
      (personId) => workbook.getPersonSummary(personId),
    );
    let browser: { status: "HEALTHY" | "FAILED"; source?: string; detail?: string };
    try {
      // macOS Chrome startup can legitimately take 10–15s after launchd/GUI
      // contention; keep the health probe bounded without changing workflow
      // navigation or production worker behavior.
      const launched = await launchCompatibleBrowser(config.browserChannel, { headless: true, timeout: 30_000 });
      await launched.browser.close();
      browser = { status: "HEALTHY", source: launched.source };
    } catch (error) {
      browser = { status: "FAILED", detail: error instanceof Error ? error.message : String(error) };
    }
    const ledger = await readFile(path.join(config.runtimeDir, "ingestion-ledger.json"), "utf8")
      .then((value) => JSON.parse(value) as Array<{ result?: string }>).catch(() => []);
    const logFiles = await readdir(config.logsDir).catch(() => []);
    const logs = await Promise.all(logFiles.filter((name) => name.endsWith(".jsonl")).map(async (name) => ({
      name, modified: (await stat(path.join(config.logsDir, name))).mtime.toISOString(),
      events: await readFile(path.join(config.logsDir, name), "utf8").then((value) => value.trim().split("\n").filter(Boolean)),
    })));
    const recentErrorCategories: Record<string, number> = {};
    for (const line of logs.flatMap((log) => log.events).slice(-200)) {
      try { const category = (JSON.parse(line) as { errorCategory?: string }).errorCategory; if (category) recentErrorCategories[category] = (recentErrorCategories[category] ?? 0) + 1; } catch { /* Ignore partial log lines. */ }
    }
    const lastReconciliation = await stat(config.reconciliationStatePath).then((value) => value.mtime.toISOString()).catch(() => null);
    const rendered = JSON.stringify({ checkedAt: new Date().toISOString(), workbookAvailable: true, browser,
      worker: { status: workerWasRunning ? "ACTIVE" : "STOPPED", configuredCount: config.workerCount,
        lastActivity: logs.map((log) => log.modified).sort().at(-1) ?? null },
      ingestion: { processed: ledger.length, duplicatesPrevented: ledger.filter((entry) => entry.result === "IDEMPOTENT").length },
      lastReconciliation, recentErrorCategories, ...status }, null, 2);
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex >= 0) {
      const requested = process.argv[outputIndex + 1]?.trim();
      if (!requested) throw new Error("--output requires a path.");
      const output = path.resolve(requested);
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      const staging = `${output}.${process.pid}.tmp`;
      await writeFile(staging, `${rendered}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(staging, output);
    }
    console.log(rendered);
    if (browser.status === "FAILED" || status.reconciliationIssues.length > 0 || status.staleInProgress > 0) process.exitCode = 1;
  } finally {
    await workbook.release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
