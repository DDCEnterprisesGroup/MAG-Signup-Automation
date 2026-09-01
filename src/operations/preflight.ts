import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import { ensureFieldRegistry } from "../fields/field-registry.js";
import { OPERATOR_RESUME_MARKER } from "../types/models.js";
import { appendNote } from "../utils/text.js";
import { buildOperationsStatus } from "./status.js";

/**
 * Startup boundary check for `mag start` / `mag restart`.
 *
 * Reuses the single production reconciliation implementation, repairs only
 * deterministic and non-destructive inconsistencies, and blocks worker launch
 * when it finds a condition that could cause duplicate submissions, false
 * completion, or lost history. It never guesses: unresolved ambiguity stops
 * startup and prints the exact issue plus the operator action required.
 */

const STALE_IN_PROGRESS_MS = 30 * 60 * 1000;
const PRE_START_KEEP = 10;

export interface PreflightResult {
  blocked: boolean;
  critical: string[];
  actions: string[];
  safeRepairs: string[];
  deterministicUpdates: number;
  lockState: "free" | "stale" | "held";
  lines: string[];
}

type Sink = (line: string) => void;

async function prunePreStartBackups(dir: string): Promise<void> {
  const names = (await readdir(dir).catch(() => []))
    .filter((name) => /^MAG_Workbook-pre-start-.*\.xlsx$/.test(name))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - PRE_START_KEEP))) {
    await rm(path.join(dir, name), { force: true });
  }
}

async function detectLockState(lockPath: string): Promise<"free" | "stale" | "held"> {
  const exists = await stat(lockPath).then(() => true).catch(() => false);
  if (!exists) return "free";
  try {
    const meta = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
    if (meta.pid) {
      process.kill(meta.pid, 0);
      return "held";
    }
  } catch {
    return "stale";
  }
  return "stale";
}

export interface PreflightOptions {
  /** True when the worker will start next (mag start / restart); false for a standalone `mag preflight`. */
  startingWorker?: boolean;
  /**
   * Present for `mag run` / `mag start --person --site`. A targeted run gets the
   * SAME integrity gate as a full start, plus pair-specific submission-safety
   * checks. It is never a bypass.
   */
  targeted?: { personId: string; siteId: string };
}

export async function runPreflight(
  providedConfig?: AppConfig,
  sink: Sink = () => undefined,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const config = providedConfig ?? (await loadConfig());
  const lines: string[] = [];
  const emit: Sink = (line) => {
    lines.push(line);
    sink(line);
  };
  const step = (label: string, state: string, detail?: string): void =>
    emit(`${label.padEnd(26)} ${state}${detail ? ` (${detail})` : ""}`);

  const critical: string[] = [];
  const actions: string[] = [];
  const safeRepairs: string[] = [];
  let deterministicUpdates = 0;

  emit("MAG STARTUP");
  emit("");

  // 1. Worker lock / single-instance safety.
  const lockState = await detectLockState(`${config.workbookPath}.lock`);
  if (lockState === "held") {
    step("Checking worker lock...", "FAIL", "another MAG process holds the workbook lock");
    critical.push("A MAG worker is already running (the workbook lock is held by a live process).");
    actions.push("Run `mag status`, then `mag stop`, before starting again.");
  } else {
    step("Checking worker lock...", "OK", lockState === "stale" ? "clearing stale lock" : undefined);
  }

  // 2 + 3. Production files + workbook accessible and schema-valid.
  let workbook: WorkbookStore | undefined;
  let registry: Awaited<ReturnType<typeof ensureFieldRegistry>> | undefined;

  if (critical.length === 0) {
    try {
      registry = await ensureFieldRegistry(config.projectRoot, config.fieldRegistryPath);
      step("Checking field registry...", "OK");
    } catch (error) {
      step("Checking field registry...", "FAIL", error instanceof Error ? error.message : String(error));
      critical.push("The field registry is missing or invalid.");
      actions.push("Restore config/field-registry.json from a backup, then re-run `mag start`.");
    }
  }

  if (critical.length === 0) {
    try {
      workbook = new WorkbookStore(config.workbookPath);
      await workbook.open();
      step("Checking workbook...", "OK", `${workbook.getPeople().length} people, ${workbook.getSites().length} sites`);
    } catch (error) {
      step("Checking workbook...", "FAIL", error instanceof Error ? error.message : String(error));
      critical.push("The workbook is unavailable, locked by another program, or has an invalid schema.");
      actions.push("Close the workbook in Excel, confirm it opens cleanly, then re-run `mag start`.");
      await workbook?.release().catch(() => undefined);
      workbook = undefined;
    }
  }

  const finish = (): PreflightResult => {
    const uniqueCritical = [...new Set(critical)];
    const uniqueActions = [...new Set(actions)];
    const safeApplied = deterministicUpdates + safeRepairs.length;
    emit("");
    if (uniqueCritical.length > 0) {
      emit("Reconciling... FAIL");
      emit("Worker NOT started.");
      emit("");
      emit("Reason:");
      for (const item of uniqueCritical) emit(`  - ${item}`);
      emit("");
      emit("Required action:");
      for (const item of uniqueActions.length ? uniqueActions : ["Review Sheet 3 Results and run `mag reconcile`."]) {
        emit(`  - ${item}`);
      }
      return { blocked: true, critical: uniqueCritical, actions: uniqueActions, safeRepairs, deterministicUpdates, lockState, lines };
    }
    emit("Reconciling... PASS");
    emit(`${uniqueCritical.length} critical conflicts`);
    if (safeApplied === 0) {
      emit("No reconciliation changes required.");
    } else {
      emit(`${safeApplied} safe update${safeApplied === 1 ? "" : "s"} applied`);
      for (const item of safeRepairs) emit(`  - ${item}`);
    }
    emit("");
    emit(options.startingWorker ? "Starting worker..." : "Startup checks passed. Run `mag start` to launch the worker.");
    return { blocked: false, critical: [], actions: [], safeRepairs, deterministicUpdates, lockState, lines };
  };

  if (!workbook || !registry) return finish();

  try {
    // 4. Lightweight pre-reconcile checkpoint.
    if (!config.dryRun) {
      await mkdir(config.backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = path.join(config.backupsDir, `MAG_Workbook-pre-start-${stamp}.xlsx`);
      await copyFile(config.workbookPath, target);
      await prunePreStartBackups(config.backupsDir);
      step("Checkpoint...", "OK", path.basename(target));
    }

    // 5. Reconcile using the existing implementation. Count only the one-time
    // assignments as "updates"; URL-duplicate rows are reported every run by
    // design, so surface them as standing context rather than as fresh changes.
    const report = await workbook.reconcile(registry, config.reconciliationStatePath);
    deterministicUpdates =
      report.peopleAssigned.length +
      report.sitesAssigned.length +
      report.peopleDefaultedPending.length +
      report.sitesDefaultedActive.length;
    const detail = [`${deterministicUpdates} deterministic update${deterministicUpdates === 1 ? "" : "s"}`];
    if (report.duplicateSites.length > 0) detail.push(`${report.duplicateSites.length} duplicate site rows parked`);
    step("Reconciling...", "done", detail.join(", "));

    // 6. Integrity analysis that can BLOCK startup.
    const status = buildOperationsStatus(
      workbook.getPeople(),
      workbook.getSites(),
      workbook.getAttempts(),
      workbook.getSiteIssues(),
      (personId) => workbook!.getPersonSummary(personId),
    );

    const personIds = new Set(workbook.getPeople().map((person) => person.id));
    const siteIds = new Set(workbook.getSitesIncludingReserved().map((site) => site.id));
    for (const attempt of workbook.getAttempts()) {
      const missingPerson = Boolean(attempt.personId) && !personIds.has(attempt.personId);
      const missingSite = Boolean(attempt.siteId) && !siteIds.has(attempt.siteId);
      if (!missingPerson && !missingSite) continue;
      const target = missingPerson ? `Person ID ${attempt.personId}` : `Site ID ${attempt.siteId}`;
      // A dangling COMPLETED or IN PROGRESS row means we cannot tell what work was
      // actually done: block and ask the operator. Any other status is terminal
      // and cannot cause a duplicate submission, so close it and keep the history.
      if (attempt.status === "COMPLETED" || attempt.status === "IN PROGRESS") {
        critical.push(`Sheet 3 Results row ${attempt.rowNumber} (${attempt.status}) references unknown ${target}.`);
        actions.push(`Restore the missing row or correct row ${attempt.rowNumber} in Sheet 3 Results, then re-run \`mag start\`.`);
        continue;
      }
      if (attempt.notes.includes("attempt closed during startup reconciliation")) continue;
      await workbook.updateAttempt(attempt, {
        status: "FAILED",
        retryEligible: "NO",
        notes: appendNote(attempt.notes, `Referenced ${target} row is missing; attempt closed during startup reconciliation.`),
      });
      safeRepairs.push(`Closed orphaned attempt row ${attempt.rowNumber} (unknown ${target}).`);
    }

    // A person still pointing at a site row that no longer exists: clear the
    // pointer so the operator display and eligibility scan stay coherent.
    for (const person of workbook.getPeople()) {
      const dangling = person.currentSiteId;
      if (dangling && !siteIds.has(dangling)) {
        await workbook.updatePerson(person, person.status, "");
        safeRepairs.push(`Cleared ${person.id} CURRENT SITE ID pointing at missing ${dangling}.`);
      }
    }

    for (const issue of status.reconciliationIssues) {
      if (issue.startsWith("duplicate attempt id")) {
        critical.push(`${issue} — duplicate attempt identifiers make completion state ambiguous.`);
        actions.push("Remove or renumber the duplicated ATTEMPT ID row in Sheet 3 Results, then re-run `mag start`.");
      }
    }

    // Summary rows claiming MORE passes than the ledger supports may indicate lost
    // history: block. Fewer passes is a stale summary we can safely rewrite.
    const latestByPair = new Map<string, ReturnType<WorkbookStore["getAttempts"]>[number]>();
    for (const attempt of workbook.getAttempts()) latestByPair.set(`${attempt.personId}:${attempt.siteId}`, attempt);
    for (const person of workbook.getPeople()) {
      const summary = workbook.getPersonSummary(person.id);
      if (!summary) continue;
      const ledgerPasses = [...latestByPair.values()].filter(
        (attempt) => attempt.personId === person.id && attempt.status === "COMPLETED",
      ).length;
      if (summary.passed > ledgerPasses) {
        critical.push(`${person.id} summary reports ${summary.passed} completed sites but the ledger supports ${ledgerPasses}.`);
        actions.push(`Confirm ${person.id}'s completed sites in Sheet 3 Results before starting.`);
      } else if (summary.passed < ledgerPasses) {
        await workbook.updatePersonSummary(person);
        safeRepairs.push(`Rewrote stale summary counts for ${person.id}.`);
      }
    }

    // Orphaned "IN PROGRESS" from a prior crash: no live worker holds the lock at
    // this point. A crash BETWEEN the final-submit checkpoint and the click is
    // impossible now (the checkpoint writes AWAITING CONFIRMATION first), so a
    // stale IN PROGRESS never submitted — route it to human re-check.
    const now = Date.now();
    for (const attempt of workbook.getAttempts()) {
      if (attempt.status !== "IN PROGRESS") continue;
      const age = now - Date.parse(attempt.attemptedAt);
      if (!Number.isFinite(age) || age <= STALE_IN_PROGRESS_MS) continue;
      const mightHaveSubmitted = /final submit|token=|awaiting confirmation|submission may occur/i.test(attempt.notes);
      await workbook.updateAttempt(attempt, {
        status: mightHaveSubmitted ? "AWAITING CONFIRMATION" : "WAITING FOR HUMAN",
        errorType: "HUMAN_CONSENT",
        retryEligible: mightHaveSubmitted ? "NO" : "YES",
        notes: appendNote(
          attempt.notes,
          mightHaveSubmitted
            ? "Worker ended around the final submit; a submit may have been sent. Parked — `mag handoff resume/confirm/skip` required."
            : "Worker ended mid-attempt (pre-submit); re-check with `mag handoff resume`.",
        ),
      });
      const person = workbook.getPeople().find((candidate) => candidate.id === attempt.personId);
      if (person) await workbook.updatePerson(person, "WAITING FOR HUMAN", attempt.siteId);
      safeRepairs.push(
        `Routed stale in-progress ${attempt.personId}/${attempt.siteId} to ${mightHaveSubmitted ? "AWAITING CONFIRMATION" : "human review"}.`,
      );
    }

    // Report (do not block on) attempts safely parked as submission-uncertain.
    const parked = workbook
      .getAttempts()
      .filter((attempt) => attempt.status === "AWAITING CONFIRMATION" && !attempt.notes.includes(OPERATOR_RESUME_MARKER));
    if (parked.length > 0) {
      step("Submission-uncertain...", `${parked.length} parked`, "resolve with `mag handoffs`");
    }

    // Targeted-run pair-specific submission safety. NEVER a bypass.
    if (options.targeted) {
      const { personId, siteId } = options.targeted;
      const pairAttempts = workbook
        .getAttempts()
        .filter((attempt) => attempt.personId === personId && attempt.siteId === siteId);
      const latest = pairAttempts.at(-1);
      if (!workbook.getPeople().some((person) => person.id === personId)) {
        critical.push(`Targeted run: Person ID ${personId} is not in the workbook.`);
      }
      if (!workbook.getSitesIncludingReserved().some((site) => site.id === siteId)) {
        critical.push(`Targeted run: Site ID ${siteId} is not in the workbook.`);
      }
      if (latest?.status === "COMPLETED") {
        critical.push(`Targeted run: ${personId}/${siteId} is already COMPLETED — refusing to re-run.`);
        actions.push("Nothing to do; this pair is finished.");
      } else if (latest?.status === "SITE INVALID") {
        critical.push(`Targeted run: ${personId}/${siteId} is SITE INVALID.`);
      } else if (latest?.status === "AWAITING CONFIRMATION" && !latest.notes.includes(OPERATOR_RESUME_MARKER)) {
        critical.push(`Targeted run: ${personId}/${siteId} is submission-uncertain (a submit may have been sent).`);
        actions.push(
          `Run \`mag handoff resume ${personId} ${siteId}\` (re-check), \`mag handoff confirm ${personId} ${siteId}\` (it went through), or \`mag handoff skip ${personId} ${siteId}\`.`,
        );
      }
      const dupIds = pairAttempts.map((attempt) => attempt.attemptId).filter(Boolean);
      if (new Set(dupIds).size !== dupIds.length) {
        critical.push(`Targeted run: ${personId}/${siteId} has duplicate ATTEMPT IDs — completion state is ambiguous.`);
      }
    }

    return finish();
  } finally {
    await workbook.release().catch(() => undefined);
  }
}
