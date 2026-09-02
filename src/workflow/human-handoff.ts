import { setTimeout as delay } from "node:timers/promises";
import { stdout as output } from "node:process";
import type { Page } from "playwright";
import type { AttemptRecord, HumanHandoffReason, PersonProfile, Site } from "../types/models.js";
import { StopRunError } from "../types/models.js";
import { safeUrl } from "../utils/text.js";
import { captureHandoffSnapshot, observeHandoffPage } from "./handoff-observer.js";
import type { OperatorControl, OperatorRequest } from "./operator-console.js";

export type OperatorHandoffDecision =
  | { kind: "completed"; reason: string }
  | { kind: "resume"; reason: string; source: "automatic" | "manual" | "validation" }
  | { kind: "control"; request: Exclude<OperatorRequest, null | "handoff"> };

async function waitForControl(control: OperatorControl, signal: AbortSignal): Promise<Exclude<OperatorRequest, null> | "stop"> {
  while (!signal.aborted) {
    if (control.stopRequested) return "stop";
    const request = await control.checkpoint();
    if (request) return request;
    await delay(100, undefined, { signal }).catch(() => undefined);
  }
  return "stop";
}

export async function waitForOperator(
  person: PersonProfile,
  site: Site,
  attempt: AttemptRecord,
  reason: HumanHandoffReason,
  page: Page,
  control: OperatorControl,
): Promise<OperatorHandoffDecision> {
  const baseline = await captureHandoffSnapshot(page);
  output.write("\n=== HUMAN ACTION REQUIRED ===\n");
  output.write(`Person: ${person.id} (${person.firstName} ${person.lastName})\n`);
  output.write(`Site: ${site.id} (${site.name})\n`);
  output.write(`Reason: ${reason.reason} [${reason.category}]\n`);
  output.write(`Current page: ${safeUrl(page.url())}\n`);
  output.write(`Attempt: ${attempt.attemptId}\n`);
  output.write("Complete the requested action in the open browser. Page changes are detected automatically.\n");
  output.write("Hotkeys remain active. Browser changes are detected and re-scanned automatically.\n");

  while (true) {
    const observerController = new AbortController();
    const observation = observeHandoffPage(page, baseline, { signal: observerController.signal })
      .then((value) => ({ source: "observer" as const, value }))
      .catch((error: unknown) => ({ source: "observer_error" as const, error }));
    const operator = waitForControl(control, observerController.signal).then((value) => ({ source: "operator" as const, value }));
    const winner = await Promise.race([observation, operator]);

    if (winner.source === "operator") {
      observerController.abort();
      if (winner.value === "stop") throw new StopRunError();
      if (winner.value === "handoff") return { kind: "resume", reason: "Operator requested a handoff re-scan", source: "manual" };
      return { kind: "control", request: winner.value };
    }
    if (winner.source === "observer_error") throw winner.error;
    observerController.abort();

    const result = winner.value;
    if (result.kind === "completed") return { kind: "completed", reason: result.reason };
    if (result.kind === "progressed") return { kind: "resume", reason: result.reason, source: "automatic" };
    if (result.kind === "validation_error") {
      output.write("\nValidation errors detected. Re-scanning without marking completion.\n");
      return { kind: "resume", reason: result.reason, source: "validation" };
    }
    return { kind: "resume", reason: `${result.reason}; automatically re-scanning current page`, source: "automatic" };
  }
}
