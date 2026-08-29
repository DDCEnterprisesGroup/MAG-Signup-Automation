import type { AttemptRecord, PersonProfile, PersonSummary, Site, SiteIssue } from "../types/models.js";

export interface OperationsStatus {
  profiles: { total: number; queued: number; active: number; completed: number; failed: number; skipped: number };
  attempts: Record<string, number>;
  humanHandoffs: number;
  retryQueue: number;
  staleInProgress: number;
  reconciliationIssues: string[];
  sites: { total: number; active: number; quarantined: number; withIssues: number };
  reconciliation: { reconciled: number; unreconciled: number };
}

export function buildOperationsStatus(
  people: readonly PersonProfile[],
  sites: readonly Site[],
  attempts: readonly AttemptRecord[],
  issues: readonly SiteIssue[],
  summaryFor: (personId: string) => PersonSummary | undefined,
  now = Date.now(),
): OperationsStatus {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) counts[attempt.status] = (counts[attempt.status] ?? 0) + 1;
  const latest = new Map<string, AttemptRecord>();
  const duplicateAttemptIds = new Set<string>();
  const seenAttemptIds = new Set<string>();
  for (const attempt of attempts) {
    if (seenAttemptIds.has(attempt.attemptId)) duplicateAttemptIds.add(attempt.attemptId);
    seenAttemptIds.add(attempt.attemptId);
    latest.set(`${attempt.personId}:${attempt.siteId}`, attempt);
  }
  const latestAttempts = [...latest.values()];
  const reconciliationIssues = [...duplicateAttemptIds].map((id) => `duplicate attempt id: ${id}`);
  for (const person of people) {
    const summary = summaryFor(person.id);
    const completed = latestAttempts.filter((attempt) => attempt.personId === person.id && attempt.status === "COMPLETED").length;
    if (summary && summary.passed !== completed) reconciliationIssues.push(`summary mismatch: ${person.id}`);
    if (person.currentSiteId && !sites.some((site) => site.id === person.currentSiteId)) {
      reconciliationIssues.push(`missing current site: ${person.id}`);
    }
  }
  const staleInProgress = latestAttempts.filter((attempt) => {
    const age = now - Date.parse(attempt.attemptedAt);
    return attempt.status === "IN PROGRESS" && Number.isFinite(age) && age > 24 * 60 * 60 * 1000;
  }).length;
  return {
    profiles: {
      total: people.length,
      queued: people.filter((person) => ["", "PENDING"].includes(person.status.trim().toUpperCase())).length,
      active: people.filter((person) => ["IN PROGRESS", "WAITING FOR HUMAN"].includes(person.status.trim().toUpperCase())).length,
      completed: people.filter((person) => person.status.trim().toUpperCase() === "COMPLETED").length,
      failed: people.filter((person) => ["FAILED", "ERROR"].includes(person.status.trim().toUpperCase())).length,
      skipped: people.filter((person) => person.status.trim().toUpperCase() === "SKIPPED").length,
    },
    attempts: counts,
    humanHandoffs: latestAttempts.filter((attempt) => attempt.status === "WAITING FOR HUMAN").length,
    retryQueue: latestAttempts.filter((attempt) => attempt.retryEligible === "YES" && ["FAILED", "TEMP FAILURE"].includes(attempt.status)).length,
    staleInProgress,
    reconciliationIssues,
    sites: {
      total: sites.length,
      active: sites.filter((site) => site.active).length,
      quarantined: sites.filter((site) => ["INVALID", "BLOCKED", "TEMP ERROR"].includes(site.status.trim().toUpperCase())).length,
      withIssues: new Set(issues.map((issue) => issue.siteId)).size,
    },
    reconciliation: {
      reconciled: latestAttempts.filter((attempt) => attempt.status === "COMPLETED").length,
      unreconciled: reconciliationIssues.length,
    },
  };
}
