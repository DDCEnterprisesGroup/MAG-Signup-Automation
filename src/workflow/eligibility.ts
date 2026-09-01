import type { AppConfig } from "../config.js";
import type { AttemptRecord } from "../types/models.js";
import { OPERATOR_RESUME_MARKER } from "../types/models.js";

/**
 * Single source of truth for "may this person/site combination be processed now?".
 *
 * Extracted from the workflow engine so the completion- and duplicate-protection
 * rules can be unit-tested directly and reused by startup preflight. The rules
 * here are deliberately conservative: completed and permanently-invalid work is
 * never reprocessed, and anything ambiguous stays retryable rather than being
 * silently dropped.
 */
export interface EligibilityConfig {
  /** Normal automatic retry budget (attempts allowed = retryCount + 1). */
  retryCount: number;
  /**
   * Extra attempts granted to sites that have only ever been deferred (operator
   * SPACE or repeated load timeouts). Prevents one slow site from consuming its
   * whole retry budget in a single pass while still bounding the defer loop.
   */
  maxAutoDeferrals: number;
}

export function eligibilityConfig(config: Pick<AppConfig, "retryCount" | "maxAutoDeferrals">): EligibilityConfig {
  return { retryCount: config.retryCount, maxAutoDeferrals: config.maxAutoDeferrals };
}

export interface EligibilityInput {
  /** Most recent attempt row for this person/site, if any. */
  latest: AttemptRecord | undefined;
  /** Total attempt rows recorded for this person/site. */
  attemptCount: number;
  /** Attempt rows for this person/site whose status is OPERATOR_DEFERRED. */
  deferralCount: number;
}

export function isSiteProcessable(input: EligibilityInput, config: EligibilityConfig): boolean {
  const { latest, attemptCount, deferralCount } = input;
  if (!latest) return true;

  // Completed and permanently-invalid work is protected from every reprocessing
  // path: restart, retry, reconciliation, hotkeys, deferred queue, crash recovery.
  if (latest.status === "COMPLETED" || latest.status === "SITE INVALID") return false;

  // Submission-uncertain quarantine: a final submit may have been sent for this
  // attempt. It is NEVER auto-processable (mag start / restart / worker
  // iteration / targeted run) — only an explicit `mag handoff resume` releases
  // it, which stamps OPERATOR_RESUME_MARKER into the note.
  if (latest.status === "AWAITING CONFIRMATION") {
    return latest.notes.includes(OPERATOR_RESUME_MARKER);
  }

  // Resume states are processable. A submission-uncertain attempt is NEVER
  // parked here as WAITING FOR HUMAN — it uses AWAITING CONFIRMATION above — so
  // this stays true for ordinary blocker handoffs (CAPTCHA, consent, …).
  if (latest.status === "WAITING FOR HUMAN" || latest.status === "IN PROGRESS") return true;

  // Operator-authorized manual reset overrides every ceiling below.
  if (latest.notes.startsWith("Manual reset authorized")) return true;

  // Operator deferrals stay retryable but are bounded so a bad site cannot loop
  // forever. Once the defer ceiling is reached the combination falls through to
  // the normal retry-budget rule instead of being deferred again.
  if (latest.status === "OPERATOR_DEFERRED") {
    if (latest.retryEligible !== "YES") return false;
    if (deferralCount <= config.retryCount + config.maxAutoDeferrals) return true;
    return attemptCount < config.retryCount + config.maxAutoDeferrals + 1;
  }

  if (latest.retryEligible === "NO") return false;
  return attemptCount < config.retryCount + 1;
}

/**
 * Whether the combination should be attempted again *within the current pass*
 * after being deferred. It never should: a deferred site waits for the next
 * `mag start` (or an explicit operator retry), which is what keeps one bad site
 * from dominating the queue.
 */
export function isDeferredForThisPass(latest: AttemptRecord | undefined): boolean {
  return latest?.status === "OPERATOR_DEFERRED";
}
