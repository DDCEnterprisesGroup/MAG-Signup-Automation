import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AppConfig {
  projectRoot: string;
  dataDir: string;
  workbookPath: string;
  fieldRegistryPath: string;
  reconciliationStatePath: string;
  headless: boolean;
  browserChannel: string;
  workerCount: number;
  navigationTimeoutMs: number;
  navigationRetryTimeoutMs: number;
  navigationRetries: number;
  retryDelayMs: number;
  siteDelayMinMs: number;
  siteDelayMaxMs: number;
  maxFormSteps: number;
  maxRepeatedPageState: number;
  screenshotOnError: boolean;
  retryCount: number;
  dryRun: boolean;
  logsDir: string;
  screenshotsDir: string;
  runtimeDir: string;
  backupsDir: string;
}

interface ConfigFile {
  headless: boolean;
  browserChannel: string;
  workerCount: number;
  navigationTimeoutMs: number;
  navigationRetryTimeoutMs: number;
  navigationRetries: number;
  retryDelayMs: number;
  siteDelayMinMs: number;
  siteDelayMaxMs: number;
  maxFormSteps: number;
  maxRepeatedPageState: number;
  screenshotOnError: boolean;
  retryCount: number;
  dryRun: boolean;
}

export function resolveDefaultDataDir(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (platform === "win32") {
    return path.win32.join(environment.LOCALAPPDATA?.trim() || path.win32.join(homeDirectory, "AppData", "Local"), "MAG-Automation");
  }
  if (platform === "darwin") return path.posix.join(homeDirectory.replaceAll("\\", "/"), "Library", "Application Support", "MAG-Automation");
  return path.posix.join((environment.XDG_DATA_HOME?.trim() || path.posix.join(homeDirectory.replaceAll("\\", "/"), ".local", "share")), "MAG-Automation");
}

const envBoolean = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false.`);
};

const envInteger = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
};

export async function loadConfig(projectRoot = process.cwd()): Promise<AppConfig> {
  const configPath = path.join(projectRoot, "config", "default.json");
  const defaults = JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
  const cliDryRun = process.argv.includes("--dry-run");
  const dataDir = path.resolve(process.env.MAG_DATA_DIR?.trim() || resolveDefaultDataDir());
  const configuredWorkbook = process.env.MAG_WORKBOOK_PATH?.trim() || process.env.WORKBOOK_PATH?.trim();

  const config: AppConfig = {
    projectRoot,
    dataDir,
    workbookPath: configuredWorkbook ? path.resolve(configuredWorkbook) : path.join(dataDir, "MAG_Workbook_Automation_Ready.xlsx"),
    fieldRegistryPath: path.resolve(process.env.MAG_FIELD_REGISTRY_PATH?.trim() || path.join(dataDir, "config", "field-registry.json")),
    reconciliationStatePath: path.join(dataDir, "config", "reconciliation-state.json"),
    headless: envBoolean("HEADLESS", defaults.headless),
    browserChannel: process.env.BROWSER_CHANNEL?.trim() || defaults.browserChannel,
    workerCount: envInteger("WORKER_COUNT", defaults.workerCount),
    navigationTimeoutMs: envInteger("NAVIGATION_TIMEOUT_MS", defaults.navigationTimeoutMs),
    navigationRetryTimeoutMs: envInteger("NAVIGATION_RETRY_TIMEOUT_MS", defaults.navigationRetryTimeoutMs),
    navigationRetries: envInteger("NAVIGATION_RETRIES", defaults.navigationRetries),
    retryDelayMs: envInteger("RETRY_DELAY_MS", defaults.retryDelayMs),
    siteDelayMinMs: envInteger("SITE_DELAY_MIN_MS", defaults.siteDelayMinMs),
    siteDelayMaxMs: envInteger("SITE_DELAY_MAX_MS", defaults.siteDelayMaxMs),
    maxFormSteps: envInteger("MAX_FORM_STEPS", defaults.maxFormSteps),
    maxRepeatedPageState: envInteger("MAX_REPEATED_PAGE_STATE", defaults.maxRepeatedPageState),
    screenshotOnError: envBoolean("SCREENSHOT_ON_ERROR", defaults.screenshotOnError),
    retryCount: envInteger("RETRY_COUNT", defaults.retryCount),
    dryRun: cliDryRun || envBoolean("DRY_RUN", defaults.dryRun),
    logsDir: path.join(dataDir, "logs"),
    screenshotsDir: path.join(dataDir, "screenshots"),
    runtimeDir: path.join(dataDir, "runtime"),
    backupsDir: path.join(dataDir, "backups"),
  };

  if (config.workerCount < 1) {
    throw new Error("WORKER_COUNT must be at least 1.");
  }
  if (config.siteDelayMaxMs < config.siteDelayMinMs) {
    throw new Error("SITE_DELAY_MAX_MS must be greater than or equal to SITE_DELAY_MIN_MS.");
  }
  if (
    config.maxFormSteps < 1 ||
    config.maxRepeatedPageState < 1 ||
    config.navigationTimeoutMs < 1 ||
    config.navigationRetryTimeoutMs < config.navigationTimeoutMs ||
    config.navigationRetries < 0 ||
    config.retryDelayMs < 0
  ) {
    throw new Error("Navigation and form-step limits must be greater than zero.");
  }
  return config;
}
