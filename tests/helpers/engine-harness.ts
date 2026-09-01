import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchCompatibleBrowser } from "../../src/browser/browser-launch.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { WorkbookStore } from "../../src/excel/workbook-store.js";
import { Logger } from "../../src/logging/logger.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { StopRunError } from "../../src/types/models.js";
import type { LiveStatus, OperatorControl, OperatorRequest } from "../../src/workflow/operator-console.js";
import { createFixtureWorkbook } from "./workbook-fixture.js";

export async function chromeAvailable(): Promise<boolean> {
  try {
    const probe = (await launchCompatibleBrowser("chrome")).browser;
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

/** No-op control; optionally emits one request on the Nth checkpoint, or stops after N. */
export class ScriptedControl implements OperatorControl {
  private calls = 0;
  private stopping = false;
  constructor(private readonly opts: { emitAt?: number; emit?: Exclude<OperatorRequest, null>; stopAt?: number } = {}) {}
  get stopRequested(): boolean {
    return this.stopping;
  }
  async checkpoint(): Promise<OperatorRequest> {
    this.calls += 1;
    if (this.opts.stopAt && this.calls >= this.opts.stopAt) this.stopping = true;
    if (this.opts.emitAt && this.calls === this.opts.emitAt) return this.opts.emit ?? null;
    return null;
  }
  suspendInput(): void {}
  resumeInput(): void {}
  setStatus(_p: LiveStatus): void {}
  progress(_m: string): void {}
  note(_m: string): void {}
  countCompleted(): void {}
  countFailed(): void {}
  countDeferred(): void {}
  countHandoff(): void {}
  close(): void {}
}

export interface Harness {
  base: string;
  requests: string[];
  wbPath: string;
  config: AppConfig;
  run(control?: OperatorControl, label?: string): Promise<{
    status: string | undefined;
    retry: string | undefined;
    notes: string;
    lastUrl: string;
    stats: Awaited<ReturnType<WorkflowEngine["run"]>>;
  }>;
  store(): Promise<WorkbookStore>;
  dispose(): Promise<void>;
}

export async function makeHarness(
  handler: (path: string, req: IncomingMessage, res: ServerResponse) => void,
  fixture?: {
    person?: string[];
    sites?: string[][];
    configOverrides?: Partial<AppConfig>;
  },
): Promise<Harness> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(route);
    res.setHeader("content-type", "text/html; charset=utf-8");
    handler(route, req, res);
    if (!res.writableEnded && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "mag-harness-"));
  const wbPath = path.join(dir, "wb.xlsx");
  const person = fixture?.person ?? [
    "P0001", "Dana", "Okafor", "5555550100", "dana.okafor@example.invalid",
    "1 Way", "Town", "FL", "32606", "01/02/1990", "Eng", "85000", "x", "PENDING", "", "",
  ];
  await createFixtureWorkbook(wbPath, {
    sites: fixture?.sites ?? [["S0001", "Site", `${base}/signup`, "YES", "ACTIVE", "", "", ""]],
    people: [person],
  });
  const config: AppConfig = {
    ...(await loadConfig()),
    workbookPath: wbPath,
    headless: true,
    browserChannel: "chrome",
    siteDelayMinMs: 0,
    siteDelayMaxMs: 0,
    navigationTimeoutMs: 12_000,
    navigationRetryTimeoutMs: 15_000,
    operatorAssistTimeoutMs: 1_500,
    logsDir: path.join(dir, "logs"),
    screenshotsDir: path.join(dir, "s"),
    runtimeDir: path.join(dir, "r"),
    dryRun: false,
    ...fixture?.configOverrides,
  };
  let logCounter = 0;
  return {
    base,
    requests,
    wbPath,
    config,
    async run(control, label) {
      const wb = new WorkbookStore(wbPath);
      await wb.open();
      try {
        const logger = await Logger.create(path.join(config.logsDir, label ?? `run${(logCounter += 1)}`));
        let stats;
        try {
          stats = await new WorkflowEngine(config, wb, logger, undefined, control).run(new Set(["P0001"]));
        } catch (error) {
          // A stop request is a legitimate "worker exited" outcome for tests
          // that simulate a crash / SIGTERM. The workbook already holds the
          // durable state written before the stop.
          if (!(error instanceof StopRunError)) throw error;
          stats = { completed: 0, failed: 0, waitingForHuman: 0, skipped: 0, deferred: 0 };
        }
        const attempt = wb.getLatestAttempt("P0001", "S0001");
        return {
          status: attempt?.status,
          retry: attempt?.retryEligible,
          notes: attempt?.notes ?? "",
          lastUrl: attempt?.lastUrl ?? "",
          stats,
        };
      } finally {
        await wb.release();
      }
    },
    async store() {
      const wb = new WorkbookStore(wbPath);
      await wb.open();
      return wb;
    },
    async dispose() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
