import type { Page } from "playwright";
import { pageStateHash } from "../utils/text.js";

export interface HandoffPageSnapshot {
  url: string;
  title: string;
  signature: string;
  bodySignature: string;
  headingSignature: string;
  formSignature: string;
  formCount: number;
  fieldCount: number;
  invalidFieldCount: number;
  validationError: boolean;
  strongSuccessText: boolean;
  strongFailureText: boolean;
  dashboardPath: boolean;
  dashboardEvidence: boolean;
}

export type HandoffObservation =
  | { kind: "completed"; reason: string; snapshot: HandoffPageSnapshot }
  | { kind: "progressed"; reason: string; snapshot: HandoffPageSnapshot }
  | { kind: "validation_error"; reason: string; snapshot: HandoffPageSnapshot }
  | { kind: "ambiguous"; reason: string; snapshot: HandoffPageSnapshot };

export interface HandoffObserverOptions {
  pollIntervalMs?: number;
  settleIntervalMs?: number;
  signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error("Handoff observation aborted");
  error.name = "AbortError";
  return error;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function captureHandoffSnapshot(page: Page): Promise<HandoffPageSnapshot> {
  const state = await page.evaluate(() => {
    const bodyText = (document.body?.innerText?.slice(0, 30_000) ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const forms = [...document.querySelectorAll("form")].filter((element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      const box = html.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    });
    const fields = [...document.querySelectorAll("input, textarea, select")].filter((element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      const box = html.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || box.width <= 0 || box.height <= 0) return false;
      const type = (element as HTMLInputElement).type?.toLowerCase() ?? "";
      return !["hidden", "submit", "button", "image", "reset"].includes(type);
    });
    const fieldSignature = fields
      .map((element) => {
        const input = element as HTMLInputElement;
        const labels = input.labels ? [...input.labels].map((label) => label.innerText).join(" ") : "";
        return [
          element.tagName,
          input.type ?? "",
          input.name ?? "",
          input.id ?? "",
          input.autocomplete ?? "",
          input.placeholder ?? "",
          element.getAttribute("aria-label") ?? "",
          labels,
        ]
          .join("|")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
      })
      .sort()
      .join("||");
    const headings = [...document.querySelectorAll("h1, h2, h3, [role='heading']")]
      .filter((element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const box = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((heading) => (heading.textContent ?? "").toLowerCase().replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("|");
    const visibleErrors = [...document.querySelectorAll("[role='alert'], .error, .errors, .invalid-feedback, .field-error, .validation-error")]
      .filter((element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const box = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((element) => (element.textContent ?? "").toLowerCase().replace(/\s+/g, " ").trim())
      .filter((text) => /\b(required|invalid|incorrect|does not match|please (enter|provide|correct)|error|try again)\b/.test(text));
    const invalidFields = fields.filter(
      (element) => element.getAttribute("aria-invalid") === "true" || (element as HTMLInputElement).matches(":invalid"),
    );
    const path = location.pathname.toLowerCase();
    return {
      url: location.href,
      title: document.title,
      bodyText,
      headings,
      fieldSignature,
      formCount: forms.length,
      fieldCount: fields.length,
      invalidFieldCount: invalidFields.length,
      validationError: visibleErrors.length > 0,
      strongSuccessText:
        /\b(thank you for (registering|signing up)|registration (is )?complete|account (has been )?created|successfully registered|signup (is )?complete)\b/.test(
          bodyText,
        ),
      strongFailureText:
        /\b(email (is )?already (exists|registered|in use)|account already exists|registration (failed|rejected)|server error|unable to (register|create)|incomplete form)\b/.test(
          bodyText,
        ),
      dashboardPath: /\/(dashboard|account|account-overview|my-account|welcome|home)(\/|$)/.test(path),
      dashboardEvidence: /\b(dashboard|account overview|my account|sign out|log out|manage (your )?profile)\b/.test(bodyText),
    };
  });

  const bodySignature = pageStateHash(state.bodyText);
  const headingSignature = pageStateHash(state.headings);
  const formSignature = pageStateHash(state.fieldSignature);
  const signature = pageStateHash(
    [state.url, state.title, bodySignature, headingSignature, formSignature, state.formCount, state.fieldCount, state.invalidFieldCount].join("|"),
  );
  return {
    url: state.url,
    title: state.title,
    signature,
    bodySignature,
    headingSignature,
    formSignature,
    formCount: state.formCount,
    fieldCount: state.fieldCount,
    invalidFieldCount: state.invalidFieldCount,
    validationError: state.validationError,
    strongSuccessText: state.strongSuccessText,
    strongFailureText: state.strongFailureText,
    dashboardPath: state.dashboardPath,
    dashboardEvidence: state.dashboardEvidence,
  };
}

export function classifyHandoffChange(
  baseline: HandoffPageSnapshot,
  current: HandoffPageSnapshot,
): HandoffObservation | undefined {
  if (current.signature === baseline.signature) return undefined;

  const urlChanged = current.url !== baseline.url;
  const formChanged = current.formSignature !== baseline.formSignature || current.fieldCount !== baseline.fieldCount;
  const headingChanged = current.headingSignature !== baseline.headingSignature;
  const formDisappeared = baseline.formCount > 0 && current.formCount === 0;
  const newValidationError =
    current.validationError ||
    current.strongFailureText ||
    current.invalidFieldCount > baseline.invalidFieldCount ||
    (current.invalidFieldCount > 0 && formChanged);

  if (newValidationError) {
    return { kind: "validation_error", reason: "Validation errors appeared after operator interaction", snapshot: current };
  }

  const explicitConfirmation = current.strongSuccessText && !baseline.strongSuccessText && current.formCount === 0;
  const confidentDashboard =
    current.dashboardPath &&
    current.dashboardEvidence &&
    current.formCount === 0 &&
    (!baseline.dashboardPath || !baseline.dashboardEvidence) &&
    (urlChanged || formDisappeared);
  if (explicitConfirmation || confidentDashboard) {
    return {
      kind: "completed",
      reason: explicitConfirmation ? "Explicit signup confirmation detected" : "Account or dashboard arrival confirmed",
      snapshot: current,
    };
  }

  const subsequentFormStep =
    current.fieldCount > 0 &&
    (formChanged || (urlChanged && (headingChanged || current.bodySignature !== baseline.bodySignature)));
  if (subsequentFormStep) {
    return { kind: "progressed", reason: "A subsequent form step was detected", snapshot: current };
  }

  const meaningfulAmbiguousChange =
    urlChanged || formDisappeared || formChanged || headingChanged || current.bodySignature !== baseline.bodySignature;
  if (meaningfulAmbiguousChange) {
    return {
      kind: "ambiguous",
      reason: "The page changed, but completion or form progression could not be confirmed",
      snapshot: current,
    };
  }
  return undefined;
}

export async function observeHandoffPage(
  page: Page,
  baseline: HandoffPageSnapshot,
  options: HandoffObserverOptions = {},
): Promise<HandoffObservation> {
  const pollIntervalMs = options.pollIntervalMs ?? 400;
  const settleIntervalMs = options.settleIntervalMs ?? 350;
  while (true) {
    await wait(pollIntervalMs, options.signal);
    if (page.isClosed()) {
      const snapshot = { ...baseline, signature: `${baseline.signature}-closed` };
      return { kind: "ambiguous", reason: "The browser page was closed during human handoff", snapshot };
    }
    let current: HandoffPageSnapshot;
    try {
      current = await captureHandoffSnapshot(page);
    } catch {
      continue;
    }
    const observation = classifyHandoffChange(baseline, current);
    if (observation) {
      if (current.url !== baseline.url) {
        await page.waitForLoadState("domcontentloaded", { timeout: 1_500 }).catch(() => undefined);
      }
      await wait(settleIntervalMs, options.signal);
      try {
        const settled = await captureHandoffSnapshot(page);
        return classifyHandoffChange(baseline, settled) ?? observation;
      } catch {
        return observation;
      }
    }
  }
}
