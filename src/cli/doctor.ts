import { access, constants, open, readFile, statfs } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { loadConfig } from "../config.js";
import { loadFieldRegistry } from "../fields/field-registry.js";
import { WorkbookStore } from "../excel/workbook-store.js";

type Level = "PASS" | "WARNING" | "FAIL";
interface Check {
  name: string;
  level: Level;
  detail: string;
}

async function check(name: string, task: () => Promise<string>, warning = false): Promise<Check> {
  try {
    return { name, level: "PASS", detail: await task() };
  } catch (error) {
    return { name, level: warning ? "WARNING" : "FAIL", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runDoctor(projectRoot = process.cwd()): Promise<Check[]> {
  const config = await loadConfig(projectRoot);
  const checks: Check[] = [];
  checks.push({
    name: "Operating system",
    level: ["win32", "darwin"].includes(process.platform) ? "PASS" : "WARNING",
    detail: `${process.platform} ${process.arch}`,
  });
  checks.push({
    name: "Node.js",
    level: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 22 ? "PASS" : "FAIL",
    detail: `v${process.versions.node}; Node 22 or newer is required`,
  });
  checks.push(await check("npm dependencies", async () => (await access(path.join(projectRoot, "node_modules")), "node_modules present")));
  checks.push(
    await check("Playwright browser", async () => {
      const browser = await chromium
        .launch({ headless: true, ...(config.browserChannel ? { channel: config.browserChannel } : {}) })
        .catch(() => chromium.launch({ headless: true }));
      await browser.close();
      return config.browserChannel || chromium.executablePath();
    }),
  );
  checks.push(await check("Workbook exists", async () => (await access(config.workbookPath, constants.R_OK), config.workbookPath)));
  checks.push(
    await check("Workbook write access", async () => {
      const handle = await open(config.workbookPath, "r+");
      await handle.close();
      return "read/write access available";
    }),
  );
  checks.push(
    await check("Workbook schema and lock", async () => {
      const store = new WorkbookStore(config.workbookPath);
      await store.open();
      try {
        return `${store.getPeople().length} people, ${store.getSites().length} sites, ${store.getAttempts().length} attempts`;
      } finally {
        await store.release();
      }
    }),
  );
  checks.push(await check("Field registry", async () => {
    const registry = await loadFieldRegistry(config.fieldRegistryPath);
    return `version ${registry.version}; ${Object.keys(registry.fields).length} approved fields`;
  }));
  checks.push(await check("Configuration", async () => `data=${config.dataDir}; headed=${!config.headless}; workers=${config.workerCount}`));
  for (const [name, directory] of [
    ["Log directory", config.logsDir],
    ["Screenshot directory", config.screenshotsDir],
    ["Runtime/profile directory", config.runtimeDir],
    ["Backup directory", config.backupsDir],
  ] as const) {
    checks.push(await check(name, async () => (await access(directory, constants.R_OK | constants.W_OK), directory)));
  }
  checks.push(
    await check(
      "Disk space",
      async () => {
        const disk = await statfs(config.dataDir);
        const freeBytes = Number(disk.bavail) * Number(disk.bsize);
        if (freeBytes < 500 * 1024 * 1024) throw new Error(`Only ${Math.round(freeBytes / 1024 / 1024)} MB free`);
        return `${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB free`;
      },
      true,
    ),
  );
  checks.push(
    await check(
      "Workbook lock marker",
      async () => {
        await readFile(`${config.workbookPath}.lock`, "utf8");
        throw new Error("Workbook lock file exists; make sure no automation process is running");
      },
      true,
    ).then((result) => (result.level === "WARNING" && /ENOENT/.test(result.detail) ? { ...result, level: "PASS", detail: "no lock marker" } : result)),
  );
  return checks;
}

const checks = await runDoctor();
for (const item of checks) console.log(`${item.level.padEnd(7)} ${item.name}: ${item.detail}`);
if (checks.some((item) => item.level === "FAIL")) process.exitCode = 1;
