import { mkdir } from "node:fs/promises";
import path from "node:path";
import { launchCompatibleBrowser } from "./browser/browser-launch.js";
import { loadConfig } from "./config.js";
import { ensureFieldRegistry } from "./fields/field-registry.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(path.dirname(config.workbookPath), { recursive: true }),
    mkdir(config.logsDir, { recursive: true }),
    mkdir(config.screenshotsDir, { recursive: true }),
    mkdir(config.runtimeDir, { recursive: true }),
    mkdir(config.backupsDir, { recursive: true }),
  ]);
  await ensureFieldRegistry(config.projectRoot, config.fieldRegistryPath);
  const launched = await launchCompatibleBrowser(config.browserChannel);
  await launched.browser.close();
  console.log(`Local data directory: ${config.dataDir}`);
  console.log(`Field registry: ${config.fieldRegistryPath}`);
  console.log(`Browser validation: ${launched.source}${launched.fallbackUsed ? " (fallback)" : ""}`);
  console.log("Setup complete. Run npm run init for a new installation, then npm run doctor.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
