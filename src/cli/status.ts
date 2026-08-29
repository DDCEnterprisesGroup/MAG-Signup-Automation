import { launchCompatibleBrowser } from "../browser/browser-launch.js";
import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import { buildOperationsStatus } from "../operations/status.js";

async function main(): Promise<void> {
  const config = await loadConfig();
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
      const launched = await launchCompatibleBrowser(config.browserChannel);
      await launched.browser.close();
      browser = { status: "HEALTHY", source: launched.source };
    } catch (error) {
      browser = { status: "FAILED", detail: error instanceof Error ? error.message : String(error) };
    }
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), browser, ...status }, null, 2));
    if (browser.status === "FAILED" || status.reconciliationIssues.length > 0 || status.staleInProgress > 0) process.exitCode = 1;
  } finally {
    await workbook.release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
