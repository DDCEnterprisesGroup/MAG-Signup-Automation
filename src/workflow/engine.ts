import type { Page } from "playwright";
import type { AppConfig } from "../config.js";
import type { FieldRegistry } from "../fields/field-registry.js";
import { BrowserSession, classifyNavigationError } from "../browser/browser-session.js";
import type { WorkbookStore } from "../excel/workbook-store.js";
import { scanAndFillPage } from "../forms/form-handler.js";
import { getDefaultFieldRegistry } from "../forms/field-mapper.js";
import { hasIdentityAnchor } from "../forms/prefill-check.js";
import type { Logger } from "../logging/logger.js";
import type {
  AttemptRecord,
  ErrorCategory,
  HumanHandoffReason,
  PersonProfile,
  RunStats,
  Site,
  SiteIssue,
} from "../types/models.js";
import { SiteControlSignal, StopRunError } from "../types/models.js";
import { normalizeUrl, safeUrl, sameSiteHost } from "../utils/text.js";
import { eligibilityConfig, isSiteProcessable } from "./eligibility.js";
import { waitForOperator, type OperatorHandoffDecision } from "./human-handoff.js";
import { NullOperatorControl, type OperatorControl } from "./operator-console.js";

type SiteOutcome = "completed" | "failed" | "invalid" | "deferred";

const terminalSiteStatuses = new Set(["DUPLICATE", "INVALID", "INACTIVE", "SITE CLOSED", "CLOSED"]);

// Failures that mean "slow / briefly unreachable", not "broken": these stay in
// the deferred retry queue instead of trending toward a permanent FAILED.
const LOAD_FAILURE_CATEGORIES = new Set<ErrorCategory>([
  "NETWORK_TIMEOUT",
  "DNS_FAILURE",
  "TEMPORARY_ERROR",
  "HTTP_5XX",
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minimum: number, maximum: number): number {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function navigationHttpCategory(status: number): ErrorCategory | undefined {
  if (status === 404 || status === 410) return "HTTP_404";
  if (status === 403) return "HTTP_403";
  if (status >= 500) return "HTTP_5XX";
  return undefined;
}

async function looksParkedOrClosed(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => "")).toLowerCase();
  const text = (await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 12_000).toLowerCase();
  return /domain (is )?for sale|buy this domain|website (is )?coming soon|account suspended|site (has been )?closed|this site can.?t be reached/.test(
    `${title} ${text}`,
  );
}

async function hasSignupSignals(page: Page): Promise<boolean> {
  const urlSignal = /\/(sign-?up|register|registration|join|create-account|account\/create)(\/|$)/i.test(page.url());
  const formSignal =
    (await page
      .locator('form input[type="email"], form input[autocomplete="email"], form input[autocomplete="given-name"], form input[name*="email" i]')
      .count()) > 0;
  return urlSignal || formSignal;
}

function issueFor(
  site: Site,
  category: SiteIssue["issueType"],
  globalStatus: SiteIssue["globalStatus"],
  finalUrl: string,
  notes: string,
  httpStatus: number | "" = "",
): SiteIssue {
  return {
    siteId: site.id,
    siteName: site.name,
    url: site.signupUrl,
    dateChecked: new Date().toISOString(),
    issueType: category,
    httpStatus,
    redirectUrl: finalUrl && safeUrl(finalUrl) !== safeUrl(site.signupUrl) ? safeUrl(finalUrl) : "",
    globalStatus,
    notes,
  };
}

export class WorkflowEngine {
  private stopRequested = false;
  private readonly stats: RunStats = { completed: 0, failed: 0, waitingForHuman: 0, skipped: 0, deferred: 0 };

  constructor(
    private readonly config: AppConfig,
    private readonly workbook: WorkbookStore,
    private readonly logger: Logger,
    private readonly fieldRegistry: FieldRegistry = getDefaultFieldRegistry(),
    private readonly control: OperatorControl = new NullOperatorControl(),
  ) {}

  requestStop(): void {
    this.stopRequested = true;
  }

  /**
   * Safe checkpoint for cooperative cancellation. Blocks while the operator has
   * paused, converts a stop request into the existing StopRunError path, and
   * returns any pending site-scoped hotkey request for the caller to apply.
   */
  private async checkpointOrStop(): Promise<"defer" | "retry" | "skip" | "handoff" | null> {
    const request = await this.control.checkpoint();
    if (this.control.stopRequested) this.stopRequested = true;
    if (this.stopRequested) throw new StopRunError("Stop requested");
    return request;
  }

  async run(selectedPersonIds?: ReadonlySet<string>, selectedSiteIds?: ReadonlySet<string>): Promise<RunStats> {
    const sites = await this.prepareEligibleSites(selectedSiteIds);
    const people = this.workbook.getPeople().filter((person) => !selectedPersonIds || selectedPersonIds.has(person.id));
    console.log(`Loaded ${people.length} processable person(s) and ${sites.length} eligible site(s).`);
    if (this.config.dryRun) console.log("DRY RUN is active: final submission controls require manual action.");

    let nextPersonIndex = 0;
    const workerCount = Math.min(this.config.workerCount, Math.max(1, people.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextPersonIndex < people.length) {
          await this.checkpointOrStop();
          const person = people[nextPersonIndex];
          nextPersonIndex += 1;
          if (person) await this.processPerson(person, sites);
        }
      }),
    );
    return { ...this.stats };
  }

  private async prepareEligibleSites(selectedSiteIds?: ReadonlySet<string>): Promise<Site[]> {
    const candidates = this.workbook
      .getSites()
      .filter(
        (site) =>
          site.active &&
          !terminalSiteStatuses.has(site.status.trim().toUpperCase()) &&
          !this.workbook.isSiteGloballyExcluded(site.id) &&
          (!selectedSiteIds || selectedSiteIds.has(site.id)),
      );
    const canonicalByUrl = new Map<string, Site>();
    const eligible: Site[] = [];

    for (const site of candidates) {
      let normalized: string;
      try {
        normalized = normalizeUrl(site.finalUrl || site.signupUrl);
      } catch {
        eligible.push(site);
        continue;
      }
      const canonical = canonicalByUrl.get(normalized);
      if (!canonical) {
        canonicalByUrl.set(normalized, site);
        eligible.push(site);
        continue;
      }
      const note = `Runtime duplicate of ${canonical.id}; no source row deleted`;
      await this.workbook.updateSite(site, "DUPLICATE", site.finalUrl || site.signupUrl, note);
      this.stats.skipped += 1;
    }
    return eligible;
  }

  private shouldProcess(person: PersonProfile, site: Site): boolean {
    return isSiteProcessable(
      {
        latest: this.workbook.getLatestAttempt(person.id, site.id),
        attemptCount: this.workbook.getAttemptCount(person.id, site.id),
        deferralCount: this.workbook.getDeferralCount(person.id, site.id),
      },
      eligibilityConfig(this.config),
    );
  }

  private async processPerson(person: PersonProfile, sites: Site[]): Promise<void> {
    this.logger.addRedactions([
      person.firstName,
      person.lastName,
      person.phone,
      person.email,
      person.address,
      person.city,
      person.state,
      person.zip,
      person.dob,
      person.occupation,
      person.annualIncome,
      person.password,
    ]);
    const remaining = sites.filter((site) => this.shouldProcess(person, site));
    if (remaining.length === 0) {
      await this.workbook.updatePersonSummary(person);
      await this.workbook.updatePerson(person, "COMPLETED");
      console.log(`${person.id} | No remaining processable sites | COMPLETED`);
      return;
    }

    const browser = new BrowserSession(this.config, this.logger, person);
    await browser.open();
    try {
      await this.workbook.updatePerson(person, "IN PROGRESS", person.currentSiteId);
      for (let index = 0; index < sites.length; index += 1) {
        const site = sites[index];
        if (!site || !this.shouldProcess(person, site)) {
          this.stats.skipped += 1;
          continue;
        }
        const preRequest = await this.checkpointOrStop();
        const progress = `${person.id} | Site ${index + 1} / ${sites.length} | ${site.name}`;
        this.control.setStatus({
          personId: person.id,
          siteId: site.id,
          siteName: site.name,
          phase: "starting",
          attempt: "",
          siteStartedAt: Date.now(),
        });
        this.control.progress(`${progress} | Starting`);
        await this.workbook.updatePerson(person, "IN PROGRESS", site.id);
        const prior = this.workbook.getLatestAttempt(person.id, site.id);
        const attempt = await this.workbook.beginOrResumeAttempt(person, site, prior);
        const outcome = await this.runSiteWithControls(browser, person, site, attempt, progress, preRequest);
        if (outcome === "completed") {
          this.stats.completed += 1;
          this.control.countCompleted();
        } else if (outcome === "failed") {
          this.stats.failed += 1;
          this.control.countFailed();
        } else if (outcome === "deferred") {
          this.stats.deferred += 1;
          this.control.countDeferred();
        } else {
          this.stats.skipped += 1;
        }
        await this.workbook.updatePersonSummary(person);
        await delay(randomDelay(this.config.siteDelayMinMs, this.config.siteDelayMaxMs));
      }
      await this.workbook.updatePersonSummary(person);
      const latest = sites.map((site) => this.workbook.getLatestAttempt(person.id, site.id));
      const pendingRetry = latest.some((attempt) => !attempt || (attempt.retryEligible === "YES" && attempt.status !== "COMPLETED"));
      const waiting = latest.some((attempt) => attempt?.status === "WAITING FOR HUMAN");
      const finalStatus = waiting ? "WAITING FOR HUMAN" : pendingRetry ? "PENDING" : "COMPLETED";
      await this.workbook.updatePerson(person, finalStatus);
      this.control.progress(`${person.id} | Current site set finished | ${finalStatus}`);
    } finally {
      await browser.close();
    }
  }

  /**
   * Runs one site attempt, translating operator hotkey signals raised at engine
   * checkpoints into safe outcomes: SPACE defers, S permanently skips, R retries
   * the same site from the top a bounded number of times.
   */
  private async runSiteWithControls(
    browser: BrowserSession,
    person: PersonProfile,
    site: Site,
    attempt: AttemptRecord,
    progress: string,
    preRequest: "defer" | "retry" | "skip" | "handoff" | null,
  ): Promise<SiteOutcome> {
    if (preRequest === "defer") return this.markDeferred(person, site, attempt, "Operator deferred before navigation");
    if (preRequest === "skip") return this.markPermanentSkip(site, attempt, "Operator permanent skip before navigation");
    if (preRequest === "retry" || preRequest === "handoff") {
      this.control.note(`${preRequest.toUpperCase()} ignored: no page is loaded yet for ${site.id}.`);
    }
    let manualRetries = 0;
    while (true) {
      try {
        return await this.processSite(browser, person, site, attempt, progress);
      } catch (error) {
        if (!(error instanceof SiteControlSignal)) throw error;
        if (error.kind === "defer") return this.markDeferred(person, site, attempt, "Operator pressed SPACE");
        if (error.kind === "skip") return this.markPermanentSkip(site, attempt, "Operator pressed S");
        manualRetries += 1;
        if (manualRetries > 3) return this.markDeferred(person, site, attempt, "Operator retry limit reached");
        await this.workbook.updateAttempt(attempt, {
          status: "IN PROGRESS",
          formStep: 0,
          errorType: "",
          retryEligible: "YES",
          notes: `Operator retry ${manualRetries}`,
        });
        this.control.note(`Retrying ${site.id} (operator retry ${manualRetries}/3).`);
      }
    }
  }

  private async markDeferred(
    person: PersonProfile,
    site: Site,
    attempt: AttemptRecord,
    reason: string,
  ): Promise<SiteOutcome> {
    const deferCount = this.workbook.getDeferralCount(attempt.personId, attempt.siteId) + 1;
    await this.workbook.updateAttempt(attempt, {
      status: "OPERATOR_DEFERRED",
      lastUrl: safeUrl(attempt.lastUrl),
      errorType: "OPERATOR_DEFERRED",
      retryEligible: "YES",
      notes: `${reason}; deferred ${deferCount}, still retryable on a later run`,
    });
    await this.logger.event({
      personId: attempt.personId,
      siteId: site.id,
      pageStep: attempt.formStep,
      action: "operator_deferred",
      outcome: "OPERATOR_DEFERRED",
      errorCategory: "OPERATOR_DEFERRED",
      message: reason,
    });
    this.control.progress(`${person.id} | ${site.id} | OPERATOR_DEFERRED | ${reason}`);
    return "deferred";
  }

  private async markPermanentSkip(site: Site, attempt: AttemptRecord, reason: string): Promise<SiteOutcome> {
    await this.workbook.updateAttempt(attempt, {
      status: "FAILED",
      lastUrl: safeUrl(attempt.lastUrl),
      retryEligible: "NO",
      notes: `${reason} ${new Date().toISOString()}`,
    });
    await this.logger.event({
      personId: attempt.personId,
      siteId: site.id,
      pageStep: attempt.formStep,
      action: "operator_permanent_skip",
      outcome: "FAILED",
      message: reason,
    });
    this.control.progress(`${attempt.personId} | ${site.id} | PERMANENT SKIP | ${reason}`);
    return "failed";
  }

  private async processSite(
    browser: BrowserSession,
    person: PersonProfile,
    site: Site,
    attempt: AttemptRecord,
    progress: string,
  ): Promise<SiteOutcome> {
    let safeToScreenshot = false;
    const targetUrl = attempt.formStep > 0 && attempt.lastUrl ? attempt.lastUrl : site.finalUrl || site.signupUrl;
    let finalUrl = targetUrl;
    try {
      let normalizedTarget: string;
      try {
        normalizedTarget = normalizeUrl(targetUrl);
      } catch {
        return await this.markInvalid(site, attempt, "SITE_ERROR", targetUrl, "Malformed signup URL");
      }

      this.control.progress(`${progress} | Navigating`);
      this.control.setStatus({ phase: "loading" });
      await this.logger.event({ personId: person.id, siteId: site.id, url: normalizedTarget, action: "navigate", outcome: "started" });
      const navigation = await browser.navigate(normalizedTarget);
      finalUrl = navigation.finalUrl;
      if (navigation.timedOutButUsable) {
        await this.logger.event({
          personId: person.id,
          siteId: site.id,
          url: finalUrl,
          action: "navigation_timeout_recovered",
          outcome: `usable DOM after ${navigation.attempts} attempt(s)`,
          errorCategory: "NETWORK_TIMEOUT",
        });
      }
      const httpCategory = navigation.status === null ? undefined : navigationHttpCategory(navigation.status);
      if (httpCategory === "HTTP_404") {
        return await this.markInvalid(site, attempt, httpCategory, finalUrl, `HTTP ${navigation.status ?? 404}`, navigation.status ?? "");
      }
      if (httpCategory === "HTTP_403") {
        return await this.markTemporary(site, attempt, httpCategory, finalUrl, "Access denied by site", navigation.status ?? 403);
      }
      if (httpCategory === "HTTP_5XX") {
        return await this.markTemporary(site, attempt, httpCategory, finalUrl, `HTTP ${navigation.status ?? 500}`, navigation.status ?? 500);
      }
      if (navigation.status !== null && navigation.status >= 400) {
        return await this.markTemporary(site, attempt, "SITE_ERROR", finalUrl, `HTTP ${navigation.status}`, navigation.status);
      }
      if (navigation.redirectCount > 0 || safeUrl(finalUrl) !== safeUrl(normalizedTarget)) {
        if (navigation.redirectCount > 10) return await this.markInvalid(site, attempt, "REDIRECT_LOOP", finalUrl, "Redirect limit exceeded");
        const legitimate = sameSiteHost(normalizedTarget, finalUrl) || (await hasSignupSignals(browser.page));
        if (!legitimate) {
          return await this.markInvalid(site, attempt, "SIGNUP_NOT_FOUND", finalUrl, "Redirect did not reach a recognizable signup page");
        }
        await this.workbook.recordSiteIssue(issueFor(site, "REDIRECT", "REDIRECTED", finalUrl, "Legitimate signup redirect followed"));
        await this.workbook.updateSite(site, "REDIRECTED", finalUrl, "Final signup URL updated after redirect");
      }
      if (await looksParkedOrClosed(browser.page)) {
        return await this.markInvalid(site, attempt, "SIGNUP_NOT_FOUND", finalUrl, "Parked, suspended, or closed site detected");
      }

      safeToScreenshot = true;
      const repeatedStates = new Map<string, number>();
      const identityFieldsSeen = new Set<string>();
      let automaticSteps = 0;
      let ledgerStep = Math.max(0, attempt.formStep);
      let sawRecognizedForm = false;
      while (true) {
        const request = await this.checkpointOrStop();
        if (request === "defer" || request === "retry" || request === "skip") throw new SiteControlSignal(request);
        if (request === "handoff") {
          const decision = await this.handoff(
            person,
            site,
            attempt,
            { category: "HUMAN_CONSENT", reason: "Operator requested a human handoff via hotkey" },
            browser.page,
          );
          if (decision.kind === "completed") {
            return await this.markCompleted(site, attempt, browser.page.url(), Math.max(1, ledgerStep), progress, decision.reason);
          }
          repeatedStates.clear();
          automaticSteps = 0;
        }
        ledgerStep += 1;
        await this.workbook.updateAttempt(attempt, {
          status: "IN PROGRESS",
          formStep: ledgerStep,
          lastUrl: safeUrl(browser.page.url()),
          errorType: "",
          retryEligible: "YES",
          notes: `Scanning page ${ledgerStep}`,
        });
        this.control.setStatus({ phase: `scanning page ${ledgerStep}`, attempt: `${automaticSteps + 1}` });
        this.control.progress(`${progress} | Scanning Page ${ledgerStep}`);
        const scan = await scanAndFillPage(browser.page, person, this.fieldRegistry);
        if (scan.recognizedFieldCount > 0) {
          sawRecognizedForm = true;
          safeToScreenshot = false;
        }
        for (const identityField of scan.identityFieldsSeen ?? []) identityFieldsSeen.add(identityField);
        if (scan.filledFields.length > 0) {
          await this.logger.event({
            personId: person.id,
            siteId: site.id,
            url: browser.page.url(),
            pageStep: ledgerStep,
            action: "fill_fields",
            outcome: scan.filledFields.join(","),
          });
        }
        if (scan.success) {
          return await this.markCompleted(site, attempt, browser.page.url(), ledgerStep, progress, "Completion confirmation detected");
        }

        const repeated = (repeatedStates.get(scan.stateHash) ?? 0) + 1;
        repeatedStates.set(scan.stateHash, repeated);
        let handoff = scan.humanHandoff;
        if (!handoff && repeated > this.config.maxRepeatedPageState) {
          handoff = { category: "FORM_NOT_RECOGNIZED", reason: "The same page state repeated beyond the configured limit" };
        }
        if (!handoff && automaticSteps >= this.config.maxFormSteps) {
          handoff = { category: "FORM_NOT_RECOGNIZED", reason: "Maximum automatic form-step limit reached" };
        }
        if (!handoff && scan.action?.kind === "ambiguous") {
          handoff = { category: "HUMAN_CONSENT", reason: `Navigation control is ambiguous: ${scan.action.label}` };
        }
        if (!handoff && scan.action?.kind === "final" && this.config.dryRun) {
          handoff = { category: "HUMAN_CONSENT", reason: `Dry run paused before final action: ${scan.action.label}` };
        }
        if (!handoff && scan.action?.kind === "final" && !hasIdentityAnchor(identityFieldsSeen)) {
          handoff = {
            category: "HUMAN_CONSENT",
            reason: `Final submission "${scan.action.label}" reached without a verified email or full-name field`,
          };
        }
        if (!handoff && !scan.action) {
          if (scan.visibleFieldCount === 0 && scan.recognizedFieldCount === 0) {
            if (!sawRecognizedForm) {
              return await this.markInvalid(site, attempt, "SIGNUP_NOT_FOUND", browser.page.url(), "No signup form or safe navigation control found");
            }
            handoff = {
              category: "FORM_NOT_RECOGNIZED",
              reason: "The form changed pages, but no clear completion confirmation or safe next action was found",
            };
          } else {
            handoff = { category: "FORM_NOT_RECOGNIZED", reason: "No safe navigation action could be determined" };
          }
        }

        if (handoff) {
          const decision = await this.handoff(person, site, attempt, handoff, browser.page);
          if (decision.kind === "completed") {
            return await this.markCompleted(site, attempt, browser.page.url(), ledgerStep, progress, decision.reason);
          }
          repeatedStates.clear();
          automaticSteps = 0;
          continue;
        }

        if (!scan.action || scan.action.kind === "ambiguous") {
          throw new Error("Internal navigation decision was incomplete.");
        }
        automaticSteps += 1;
        await this.logger.event({
          personId: person.id,
          siteId: site.id,
          url: browser.page.url(),
          pageStep: ledgerStep,
          action: scan.action.kind === "final" ? "click_final" : "click_next",
          outcome: scan.action.label,
        });
        await browser.clickAndSettle(scan.action.locator);
      }
    } catch (error) {
      if (error instanceof StopRunError || error instanceof SiteControlSignal) throw error;
      const category = classifyNavigationError(error);
      await browser.screenshotIfSafe(site, attempt.formStep, safeToScreenshot, category).catch(() => undefined);
      if (category === "REDIRECT_LOOP") return await this.markInvalid(site, attempt, category, finalUrl, "Redirect loop detected");
      return await this.markTemporary(site, attempt, category, finalUrl, error instanceof Error ? error.message : category);
    }
  }

  private async handoff(
    person: PersonProfile,
    site: Site,
    attempt: AttemptRecord,
    reason: HumanHandoffReason,
    page: Page,
  ): Promise<OperatorHandoffDecision> {
    const currentUrl = page.url();
    this.stats.waitingForHuman += 1;
    await this.workbook.updateAttempt(attempt, {
      status: "WAITING FOR HUMAN",
      lastUrl: safeUrl(currentUrl),
      errorType: reason.category,
      retryEligible: "YES",
      notes: reason.reason,
    });
    await this.workbook.updatePerson(person, "WAITING FOR HUMAN", site.id);
    await this.workbook.updatePersonSummary(person);
    await this.logger.event({
      personId: person.id,
      siteId: site.id,
      url: currentUrl,
      pageStep: attempt.formStep,
      action: "human_handoff",
      outcome: "WAITING FOR HUMAN",
      errorCategory: reason.category,
      message: reason.reason,
    });
    this.control.countHandoff();
    this.control.setStatus({ phase: "waiting for human" });
    // Release the raw-mode keyboard so the handoff prompt's own readline can use stdin.
    this.control.suspendInput();
    let decision: OperatorHandoffDecision;
    try {
      decision = await waitForOperator(person, site, attempt, reason, page);
    } finally {
      this.control.resumeInput();
    }
    this.stats.waitingForHuman = Math.max(0, this.stats.waitingForHuman - 1);
    if (decision.kind === "completed") return decision;

    const resumedUrl = page.url();
    await this.workbook.updateAttempt(attempt, {
      status: "IN PROGRESS",
      lastUrl: safeUrl(resumedUrl),
      errorType: "",
      retryEligible: "YES",
      notes: `${decision.reason}; re-scanning current flow`,
    });
    await this.workbook.updatePerson(person, "IN PROGRESS", site.id);
    await this.logger.event({
      personId: person.id,
      siteId: site.id,
      url: resumedUrl,
      pageStep: attempt.formStep,
      action: "human_handoff_resume",
      outcome: decision.source,
      message: decision.reason,
    });
    return decision;
  }

  private async markCompleted(
    site: Site,
    attempt: AttemptRecord,
    currentUrl: string,
    ledgerStep: number,
    progress: string,
    reason: string,
  ): Promise<SiteOutcome> {
    await this.workbook.updateAttempt(attempt, {
      status: "COMPLETED",
      lastUrl: safeUrl(currentUrl),
      errorType: "",
      retryEligible: "NO",
      notes: reason,
    });
    await this.workbook.updateSite(site, "ACTIVE", currentUrl, "Signup completed");
    await this.logger.event({
      personId: attempt.personId,
      siteId: site.id,
      url: currentUrl,
      pageStep: ledgerStep,
      action: "complete",
      outcome: "COMPLETED",
      message: reason,
    });
    this.control.progress(`${progress} | COMPLETED`);
    return "completed";
  }

  private async markInvalid(
    site: Site,
    attempt: AttemptRecord,
    category: ErrorCategory,
    finalUrl: string,
    note: string,
    httpStatus: number | "" = "",
  ): Promise<SiteOutcome> {
    await this.workbook.updateAttempt(attempt, {
      status: "SITE INVALID",
      lastUrl: safeUrl(finalUrl),
      errorType: category,
      retryEligible: "NO",
      notes: note,
    });
    await this.workbook.recordSiteIssue(issueFor(site, category, "INVALID", finalUrl, note, httpStatus));
    await this.workbook.updateSite(site, "INVALID", finalUrl, note);
    await this.logger.event({
      siteId: site.id,
      url: finalUrl,
      pageStep: attempt.formStep,
      action: "site_classification",
      outcome: "SITE INVALID",
      errorCategory: category,
      message: note,
    });
    this.control.progress(`${site.id} | SITE INVALID | ${category}`);
    return "invalid";
  }

  private async markTemporary(
    site: Site,
    attempt: AttemptRecord,
    category: ErrorCategory,
    finalUrl: string,
    note: string,
    httpStatus: number | "" = "",
  ): Promise<SiteOutcome> {
    const attemptsUsed = this.workbook.getAttemptCount(attempt.personId, attempt.siteId);

    // A slow or briefly-unreachable site is not a broken site. Load-related
    // failures go to the deferred retry queue and stay retryable up to a wider
    // ceiling; they are only converted to a permanent FAILED once that wider
    // ceiling is exhausted. Access blocks and other site errors keep the normal
    // (narrower) retry budget.
    if (LOAD_FAILURE_CATEGORIES.has(category) && attemptsUsed < this.config.retryCount + this.config.maxAutoDeferrals + 1) {
      return this.deferLoadFailure(site, attempt, category, finalUrl, note, httpStatus);
    }

    const retryEligible = attemptsUsed < this.config.retryCount + 1 ? "YES" : "NO";
    const status = retryEligible === "YES" ? "TEMP FAILURE" : "FAILED";
    await this.workbook.updateAttempt(attempt, {
      status,
      lastUrl: safeUrl(finalUrl),
      errorType: category,
      retryEligible,
      notes: note,
    });
    const globalStatus = category === "HTTP_403" || category === "ACCESS_BLOCKED" ? "BLOCKED" : "TEMP ERROR";
    await this.workbook.recordSiteIssue(issueFor(site, category, globalStatus, finalUrl, note, httpStatus));
    await this.workbook.updateSite(site, globalStatus, finalUrl, note);
    await this.logger.event({
      personId: attempt.personId,
      siteId: site.id,
      url: finalUrl,
      pageStep: attempt.formStep,
      action: "attempt_failure",
      outcome: status,
      errorCategory: category,
      message: note,
    });
    this.control.progress(`${site.id} | ${status} | ${category}`);
    return "failed";
  }

  private async deferLoadFailure(
    site: Site,
    attempt: AttemptRecord,
    category: ErrorCategory,
    finalUrl: string,
    note: string,
    httpStatus: number | "" = "",
  ): Promise<SiteOutcome> {
    const deferCount = this.workbook.getDeferralCount(attempt.personId, attempt.siteId) + 1;
    await this.workbook.updateAttempt(attempt, {
      status: "OPERATOR_DEFERRED",
      lastUrl: safeUrl(finalUrl),
      errorType: category,
      retryEligible: "YES",
      notes: `${note}; slow or unreachable, deferred ${deferCount} to the retry queue`,
    });
    await this.workbook.recordSiteIssue(issueFor(site, category, "TEMP ERROR", finalUrl, note, httpStatus));
    await this.workbook.updateSite(site, "TEMP ERROR", finalUrl, `${note} (deferred for retry)`);
    await this.logger.event({
      personId: attempt.personId,
      siteId: site.id,
      url: finalUrl,
      pageStep: attempt.formStep,
      action: "attempt_deferred",
      outcome: "OPERATOR_DEFERRED",
      errorCategory: category,
      message: `${note} — will retry on a later run (${deferCount})`,
    });
    this.control.progress(`${site.id} | OPERATOR_DEFERRED | ${category} | retry later (${deferCount})`);
    return "deferred";
  }
}
