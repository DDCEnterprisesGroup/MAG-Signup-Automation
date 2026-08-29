import { chromium, type Browser, type LaunchOptions } from "playwright";

export interface BrowserLaunchResult {
  browser: Browser;
  source: string;
  fallbackUsed: boolean;
}

/** Prefer configured Chrome, then use the lockfile-compatible managed Chromium. */
export async function launchCompatibleBrowser(
  channel: string,
  options: LaunchOptions = { headless: true },
): Promise<BrowserLaunchResult> {
  const boundedOptions = { ...options, timeout: options.timeout ?? 15_000 };
  if (channel) {
    try {
      return { browser: await chromium.launch({ ...boundedOptions, channel }), source: `channel:${channel}`, fallbackUsed: false };
    } catch {
      // A migrated config can name Chrome even when only managed Chromium is installed.
    }
  }
  return {
    browser: await chromium.launch(boundedOptions),
    source: `playwright:${chromium.executablePath()}`,
    fallbackUsed: Boolean(channel),
  };
}
