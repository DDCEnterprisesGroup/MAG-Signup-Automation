import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Response } from "playwright";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { ErrorCategory, PersonProfile, Site } from "../types/models.js";
import { safeFileSegment } from "../utils/text.js";

export interface NavigationResult {
  response: Response | null;
  finalUrl: string;
  status: number | null;
  redirectCount: number;
  attempts: number;
  timedOutButUsable: boolean;
}

export class BrowserSession {
  private context: BrowserContext | undefined;
  private pageValue: Page | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly person: PersonProfile,
  ) {}

  get page(): Page {
    if (!this.pageValue) throw new Error("Browser session is not open.");
    return this.pageValue;
  }

  async open(): Promise<void> {
    const profileDir = path.join(this.config.runtimeDir, "browser-profiles", safeFileSegment(this.person.id));
    await mkdir(profileDir, { recursive: true });
    const options = {
      headless: this.config.headless,
      channel: this.config.browserChannel,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
    } as const;
    try {
      this.context = await chromium.launchPersistentContext(profileDir, options);
    } catch (error) {
      if (!this.config.browserChannel) throw error;
      await this.logger.event({
        personId: this.person.id,
        action: "browser_launch_fallback",
        outcome: "configured channel unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      const { channel: _channel, ...fallbackOptions } = options;
      this.context = await chromium.launchPersistentContext(profileDir, fallbackOptions);
    }
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    this.context.setDefaultTimeout(Math.min(this.config.navigationTimeoutMs, 15_000));
    this.pageValue = this.context.pages()[0] ?? (await this.context.newPage());
    this.context.on("page", (page) => {
      this.pageValue = page;
    });
  }

  async navigate(url: string): Promise<NavigationResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.navigationRetries; attempt += 1) {
      const timeout = attempt === 0 ? this.config.navigationTimeoutMs : this.config.navigationRetryTimeoutMs;
      try {
        const response = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout });
        await this.page.waitForLoadState("networkidle", { timeout: Math.min(5_000, timeout) }).catch(() => undefined);
        let redirectCount = 0;
        let request = response?.request();
        while (request?.redirectedFrom()) {
          redirectCount += 1;
          request = request.redirectedFrom() ?? undefined;
        }
        return { response, finalUrl: this.page.url(), status: response?.status() ?? null, redirectCount, attempts: attempt + 1, timedOutButUsable: false };
      } catch (error) {
        lastError = error;
        const category = classifyNavigationError(error);
        if (category === "NETWORK_TIMEOUT") {
          const usableDom = await this.page
            .evaluate(() => {
              const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
              const usableForm = Boolean(document.querySelector("form input, form select, form textarea, input[type='email'], input[autocomplete='given-name']"));
              return usableForm || text.length >= 120;
            })
            .catch(() => false);
          if (usableDom) {
            return {
              response: null,
              finalUrl: this.page.url(),
              status: null,
              redirectCount: 0,
              attempts: attempt + 1,
              timedOutButUsable: true,
            };
          }
        }
        if (attempt < this.config.navigationRetries) {
          await this.page.evaluate(() => window.stop()).catch(() => undefined);
          await this.page.waitForTimeout(this.config.retryDelayMs);
        }
      }
    }
    throw lastError;
  }

  async clickAndSettle(locator: import("playwright").Locator): Promise<void> {
    const priorPage = this.pageValue;
    await locator.click({ timeout: 10_000 });
    // A signup entry control may open a new tab. The context listener makes it
    // the active workflow page; otherwise continue on the original page.
    if (this.pageValue === priorPage) await this.page.waitForLoadState("domcontentloaded", { timeout: Math.min(10_000, this.config.navigationTimeoutMs) }).catch(() => undefined);
    await this.page.waitForTimeout(600);
  }

  async screenshotIfSafe(site: Site, step: number, safe: boolean, category: ErrorCategory): Promise<string | undefined> {
    if (!this.config.screenshotOnError || !safe) return undefined;
    await mkdir(this.config.screenshotsDir, { recursive: true });
    const filename = `${safeFileSegment(this.person.id)}-${safeFileSegment(site.id)}-step-${step}-${category}.png`;
    const screenshotPath = path.join(this.config.screenshotsDir, filename);
    await this.page.screenshot({ path: screenshotPath, fullPage: false });
    return screenshotPath;
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.pageValue = undefined;
  }
}

export function classifyNavigationError(error: unknown): ErrorCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/timeout|timed out/.test(message)) return "NETWORK_TIMEOUT";
  if (/err_name_not_resolved|dns|enotfound|getaddrinfo/.test(message)) return "DNS_FAILURE";
  if (/too_many_redirects|redirect loop/.test(message)) return "REDIRECT_LOOP";
  if (/certificate|ssl|err_cert/.test(message)) return "SITE_ERROR";
  if (/err_connection|econnreset|econnrefused|network/.test(message)) return "TEMPORARY_ERROR";
  return "AUTOMATION_ERROR";
}
