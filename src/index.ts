import { loadConfig } from "./config.js";
import { WorkbookStore } from "./excel/workbook-store.js";
import { ensureFieldRegistry } from "./fields/field-registry.js";
import { Logger } from "./logging/logger.js";
import { StopRunError } from "./types/models.js";
import { WorkflowEngine } from "./workflow/engine.js";
import { NullOperatorControl, OperatorConsole, type OperatorControl } from "./workflow/operator-console.js";
import { selectPeople } from "./workflow/person-selector.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = await Logger.create(config.logsDir);
  const workbook = new WorkbookStore(config.workbookPath);
  await workbook.open();
  let engine: WorkflowEngine | undefined;
  const control: OperatorControl = OperatorConsole.isAvailable() ? new OperatorConsole() : new NullOperatorControl();
  let interruptCount = 0;
  const onInterrupt = (): void => {
    interruptCount += 1;
    engine?.requestStop();
    console.log("\nSafe stop requested. The current checkpoint will be preserved.");
    if (interruptCount > 1) console.log("Use the human-handoff prompt's q command if the run is waiting for input.");
  };
  try {
    const registry = await ensureFieldRegistry(config.projectRoot, config.fieldRegistryPath);
    const reconciliation = await workbook.reconcile(registry, config.reconciliationStatePath);
    const eligibleSites = workbook.getSites().filter((site) => site.active && site.status.trim().toUpperCase() !== "DUPLICATE");
    const siteIndex = process.argv.indexOf("--site");
    const requestedSiteId = siteIndex >= 0 ? process.argv[siteIndex + 1]?.trim().toUpperCase() : undefined;
    if (siteIndex >= 0 && !requestedSiteId) throw new Error("--site requires a Site ID, for example --site S0001.");
    if (requestedSiteId && !eligibleSites.some((site) => site.id.toUpperCase() === requestedSiteId)) {
      throw new Error(`Eligible Site ID not found: ${requestedSiteId}.`);
    }
    const packageJson = JSON.parse(await readFile(path.join(config.projectRoot, "package.json"), "utf8")) as { version: string };
    const selection = await selectPeople(workbook, eligibleSites, packageJson.version);
    if (selection.mode === "quit") {
      console.log("No people selected. Exiting without processing sites.");
      return;
    }
    engine = new WorkflowEngine(config, workbook, logger, registry, control);
    process.on("SIGINT", onInterrupt);
    if (control instanceof OperatorConsole) control.start();
    console.log(`Workbook: ${config.workbookPath}`);
    console.log(`Log: ${logger.logPath}`);
    if (reconciliation.unknownFields.length > 0) {
      console.warn(`NEW FIELD REQUIRES MAPPING: ${reconciliation.unknownFields.join(", ")}`);
    }
    if (reconciliation.restrictedFields.length > 0) {
      console.warn(`Restricted workbook field(s) remain manual-only: ${reconciliation.restrictedFields.join(", ")}`);
    }
    const stats = await engine.run(new Set(selection.personIds), requestedSiteId ? new Set([requestedSiteId]) : undefined);
    console.log(
      `Run finished | completed=${stats.completed} failed=${stats.failed} deferred=${stats.deferred} waiting=${stats.waitingForHuman} skipped=${stats.skipped}`,
    );
  } catch (error) {
    if (error instanceof StopRunError) {
      console.log(`Run stopped safely: ${error.message}. npm start will resume from the detailed ledger.`);
      return;
    }
    await logger.event({
      action: "run_error",
      outcome: "FAILED",
      errorCategory: "AUTOMATION_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    control.close();
    process.off("SIGINT", onInterrupt);
    await workbook.release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
import { readFile } from "node:fs/promises";
import path from "node:path";
