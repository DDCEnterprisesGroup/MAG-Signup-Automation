import type { Locator, Page } from "playwright";
import type { FieldRegistry } from "../fields/field-registry.js";
import type { AccountFlowContext, HumanHandoffReason, PersonProfile } from "../types/models.js";
import { pageStateHash } from "../utils/text.js";
import {
  detectRestrictedSensitiveField,
  descriptorText,
  getDefaultFieldRegistry,
  matchProfileField,
  profileValue,
  type FieldDescriptor,
  type FieldMatch,
} from "./field-mapper.js";
import { IDENTITY_FIELDS, prefilledValueConflicts } from "./prefill-check.js";

export type NavigationAction =
  | { kind: "signup"; locator: Locator; label: string; confidence: number }
  | { kind: "next"; locator: Locator; label: string; confidence: number }
  | { kind: "final"; locator: Locator; label: string; confidence: number }
  | { kind: "ambiguous"; locator?: Locator; label: string; confidence: number };

export interface PageScanResult {
  success: boolean;
  filledFields: string[];
  recognizedFieldCount: number;
  visibleFieldCount: number;
  accountFlow: AccountFlowContext;
  humanHandoff?: HumanHandoffReason;
  action?: NavigationAction;
  stateHash: string;
  phase: "LANDING_OR_INTERMEDIATE" | "REGISTRATION_FORM" | "FINAL_REGISTRATION_STEP" | "BLOCKED" | "COMPLETE";
  /** Identity fields (email / firstName / lastName) this scan filled or confirmed as matching the client. */
  identityFieldsSeen?: string[];
}

const otpPattern = /\b(one time code|one time password|verification code|otp|authentication code|confirm code)\b/;
const smsPattern = /\b(text message|sms|verify (your )?phone|phone verification)\b/;
const emailVerificationPattern =
  /\b(check your (email|inbox)( for| to)?|we (have )?sent (you )?an? email|confirmation link (has been|was) sent)\b/;
const validationTextPattern = /\b(required|invalid|incorrect|does not match|please (enter|provide|correct)|validation error|try again)\b/;

async function collectFields(page: Page): Promise<FieldDescriptor[]> {
  return page.locator("input, textarea, select").evaluateAll((elements) =>
    elements.flatMap((element, domIndex) => {
      const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const style = window.getComputedStyle(field);
      const box = field.getBoundingClientRect();
      const visible = style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
      const type = field instanceof HTMLInputElement ? field.type.toLowerCase() : field.tagName.toLowerCase();
      if (!visible || type === "hidden" || type === "submit" || type === "button" || type === "image" || type === "reset") return [];
      const labels = "labels" in field && field.labels ? [...field.labels].map((label) => label.innerText).join(" ") : "";
      const closestLabel = field.closest("label")?.innerText ?? "";
      const contextContainer = field.closest("fieldset, [role='group']") ?? field.parentElement;
      const legend = field.closest("fieldset")?.querySelector("legend")?.textContent ?? "";
      const nearby = `${legend} ${contextContainer?.textContent ?? ""}`.slice(0, 1_000);
      return [
        {
          domIndex,
          tag: field.tagName.toLowerCase() as "input" | "textarea" | "select",
          type,
          required: field.required,
          invalid: field.matches(":invalid") || field.getAttribute("aria-invalid") === "true",
          disabled: field.disabled,
          readOnly: "readOnly" in field ? field.readOnly : false,
          currentValue: field.value ?? "",
          label: `${labels} ${closestLabel}`.trim(),
          placeholder: field.getAttribute("placeholder") ?? "",
          name: field.getAttribute("name") ?? "",
          id: field.id ?? "",
          autocomplete: field.getAttribute("autocomplete") ?? "",
          ariaLabel: field.getAttribute("aria-label") ?? "",
          nearbyText: nearby,
        },
      ];
    }),
  );
}

export async function classifyAccountFlow(page: Page): Promise<AccountFlowContext> {
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    heading: [...document.querySelectorAll("h1, h2, [role='heading']")].map((element) => element.textContent ?? "").join(" "),
    buttons: [...document.querySelectorAll("button, input[type='submit']")]
      .map((element) => (element as HTMLInputElement).value || element.textContent || element.getAttribute("aria-label") || "")
      .join(" "),
    body: (document.body?.innerText ?? "").slice(0, 12_000),
  }));
  const text = `${state.url} ${state.title} ${state.heading} ${state.buttons} ${state.body}`.toLowerCase();
  const registration = /\b(sign[ -]?up|register|registration|create (an? )?account|join now|new account|create profile)\b/.test(text);
  const reset = /\b(forgot(ten)? password|reset password|recover (your )?account|password recovery)\b/.test(text);
  const login = /\b(log[ -]?in|sign[ -]?in|existing account|welcome back)\b/.test(text);
  if (reset) return "password-reset";
  if (registration && !login) return "registration";
  if (login && !registration) return "login";
  return "ambiguous";
}

async function visibleValidationErrors(page: Page): Promise<boolean> {
  return page
    .locator("[role='alert'], .error, .errors, .invalid-feedback, .field-error, .validation-error")
    .evaluateAll((elements, patternSource) => {
      const pattern = new RegExp(String(patternSource), "i");
      return elements.some((element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const box = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0 && pattern.test(element.textContent ?? "");
      });
    }, validationTextPattern.source)
    .catch(() => false);
}

async function detectPageBlocker(
  page: Page,
  fields: FieldDescriptor[],
  profile: PersonProfile,
  accountFlow: AccountFlowContext,
): Promise<HumanHandoffReason | undefined> {
  const captchaFrame = page.locator('iframe[src*="captcha" i], iframe[title*="captcha" i], iframe[src*="challenge" i]');
  if ((await captchaFrame.count()) > 0) return { category: "CAPTCHA", reason: "CAPTCHA or browser challenge detected" };

  // Cross-origin payment / card-processing widgets: never auto-submit a
  // payment-adjacent form.
  const paymentFrame = page.locator(
    [
      'iframe[src*="stripe.com" i]',
      'iframe[src*="js.stripe" i]',
      'iframe[name*="__privateStripeFrame" i]',
      'iframe[src*="paypal.com" i]',
      'iframe[src*="paypalobjects" i]',
      'iframe[src*="braintreegateway" i]',
      'iframe[src*="squareup.com" i]',
      'iframe[src*="squarecdn" i]',
      'iframe[src*="adyen.com" i]',
      'iframe[src*="checkout.com" i]',
      'iframe[src*="recurly.com" i]',
      'iframe[title*="secure payment" i]',
      'iframe[title*="card number" i]',
      'iframe[title*="credit card" i]',
    ].join(", "),
  );
  if ((await paymentFrame.count()) > 0) {
    return { category: "HUMAN_CONSENT", reason: "Payment / card-processing widget present — operator must review before any submission" };
  }

  const bodyText = (await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 30_000).toLowerCase();
  if (/captcha|i am not a robot|i'm not a robot|verify you are human|checking your browser/.test(bodyText)) {
    return { category: "CAPTCHA", reason: "Human or anti-bot verification detected" };
  }
  if (emailVerificationPattern.test(bodyText)) return { category: "EMAIL_VERIFICATION", reason: "Email verification is required" };
  if (smsPattern.test(bodyText) && otpPattern.test(bodyText)) {
    return { category: "SMS_VERIFICATION", reason: "SMS verification is required" };
  }
  if (await visibleValidationErrors(page)) return { category: "REQUIRED_MANUAL_FIELD", reason: "Visible validation errors require review" };

  for (const field of fields) {
    const text = descriptorText(field);
    const sensitive = detectRestrictedSensitiveField(field);
    if (sensitive?.kind === "password") {
      if (accountFlow !== "registration") {
        return { category: "REQUIRED_MANUAL_FIELD", reason: "Password autofill is allowed only in a confidently identified registration flow" };
      }
      if (!profile.password && (field.required || field.invalid)) {
        return { category: "REQUIRED_MANUAL_FIELD", reason: "A registration password is required but no approved workbook value is available" };
      }
    } else if (sensitive) {
      return {
        category: sensitive.kind === "verification" && smsPattern.test(bodyText) ? "SMS_VERIFICATION" : "REQUIRED_MANUAL_FIELD",
        reason: `Restricted ${sensitive.reason} requires operator input`,
      };
    }
    if (field.type === "file" && (field.required || field.invalid)) {
      return { category: "REQUIRED_MANUAL_FIELD", reason: "A required file or identity document is operator-controlled" };
    }
    if (field.autocomplete.toLowerCase() === "one-time-code" || otpPattern.test(text)) {
      return { category: smsPattern.test(bodyText) ? "SMS_VERIFICATION" : "REQUIRED_MANUAL_FIELD", reason: "Verification code is required" };
    }
    if ((field.type === "checkbox" || field.type === "radio") && (field.required || field.invalid)) {
      return { category: "HUMAN_CONSENT", reason: "A required consent or choice needs operator review" };
    }
  }

  // Fallback payment/billing context detection (card FIELDS are already caught
  // above by restricted-field detection). A strong combined signal only.
  const strongPayment =
    /\b(credit[ -]?card number|card verification (code|number)|payment method|billing information|complete (your )?payment|proceed to (payment|checkout))\b/.test(
      bodyText,
    ) || (/\bcard number\b/.test(bodyText) && /\b(cvv|cvc|expir)\b/.test(bodyText));
  if (strongPayment) {
    return { category: "HUMAN_CONSENT", reason: "Payment / billing context detected — operator must review before any submission" };
  }
  return undefined;
}

async function fillSelect(locator: Locator, value: string, match: FieldMatch): Promise<boolean> {
  const options = await locator.locator("option").evaluateAll((elements) =>
    elements.map((element) => ({ label: (element.textContent ?? "").trim(), value: (element as HTMLOptionElement).value })),
  );
  const normalized = value.trim().toLowerCase();
  const numeric = String(Number.parseInt(normalized, 10));
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const matchOption = options.find((option) => {
    const optionValue = option.value.trim().toLowerCase();
    const optionLabel = option.label.trim().toLowerCase();
    if (optionValue === normalized || optionLabel === normalized) return true;
    if ([optionValue, optionLabel].includes(numeric)) return true;
    if (match.field === "dobMonth") {
      const monthIndex = Number.parseInt(normalized, 10) - 1;
      const name = monthNames[monthIndex];
      return Boolean(name && (optionLabel === name || optionLabel.startsWith(name.slice(0, 3))));
    }
    return false;
  });
  if (!matchOption) return false;
  await locator.selectOption(matchOption.value);
  return true;
}

async function findNavigationAction(
  page: Page,
  recognizedFieldCount: number,
  accountFlow: AccountFlowContext,
): Promise<NavigationAction | undefined> {
  const controls = page.locator('button, input[type="submit"], input[type="button"]');
  const count = await controls.count();
  const candidates: Array<{
    index: number;
    text: string;
    insideForm: boolean;
    formText: string;
    scopeText: string;
    disabled: boolean;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    candidates.push(
      await control.evaluate((element, controlIndex) => {
        const form = element.closest("form");
        // Scope text = the form's own text plus the nearest heading that labels
        // it (a heading immediately before the form, or the enclosing section's
        // heading). This keeps registration intent local to the form without
        // trusting arbitrary whole-page copy.
        let headingText = "";
        if (form) {
          let node: Element | null = form.previousElementSibling;
          for (let hop = 0; node && hop < 3; hop += 1) {
            if (/^H[1-4]$/.test(node.tagName)) {
              headingText = node.textContent ?? "";
              break;
            }
            node = node.previousElementSibling;
          }
          if (!headingText) {
            const section = form.closest("section, main, article, [role='main']");
            headingText = section?.querySelector("h1, h2, h3")?.textContent ?? "";
          }
        }
        return {
          index: controlIndex,
          text: ((element as HTMLInputElement).value || element.textContent || element.getAttribute("aria-label") || "").trim(),
          insideForm: Boolean(form),
          formText: (form?.innerText ?? "").slice(0, 3_000),
          scopeText: `${headingText} ${form?.innerText ?? ""}`.slice(0, 3_000),
          disabled: (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true",
        };
      }, index),
    );
  }

  for (const candidate of candidates) {
    if (candidate.disabled || !candidate.insideForm) continue;
    const label = candidate.text.replace(/\s+/g, " ").trim();
    if (/^(next|continue|proceed|save\s*(and|&)\s*continue)$/i.test(label)) {
      if (/\b(by (clicking|selecting|continuing)|i agree|consent to|agree to the terms)\b/i.test(candidate.formText)) {
        return { kind: "ambiguous", locator: controls.nth(candidate.index), label, confidence: 35 };
      }
      if (recognizedFieldCount >= 1) return { kind: "next", locator: controls.nth(candidate.index), label, confidence: 95 };
      return { kind: "ambiguous", locator: controls.nth(candidate.index), label, confidence: 45 };
    }
  }
  for (const candidate of candidates) {
    if (candidate.disabled || !candidate.insideForm) continue;
    const label = candidate.text.replace(/\s+/g, " ").trim();
    const finalLabel = /^(submit|register( now)?|create( my| an)? account|complete registration|finish|sign up|join|create profile)$/i.test(label);
    if (!finalLabel) continue;
    if (accountFlow !== "registration") return { kind: "ambiguous", locator: controls.nth(candidate.index), label, confidence: 35 };
    if (/\b(by (clicking|selecting|creating|registering|signing up)|i agree|consent to|agree to the terms)\b/i.test(candidate.formText)) {
      return { kind: "ambiguous", locator: controls.nth(candidate.index), label, confidence: 35 };
    }
    // Form-scoped registration intent. A strong label ("register", "create
    // account", "sign up", "create profile") is self-evidencing. A generic label
    // ("submit", "finish", "join") must have account-creation evidence in the
    // SAME form's own text — otherwise it is a newsletter / contact / generic
    // form and must not auto-submit.
    const strongLabel = /^(register( now)?|create( my| an)? account|complete registration|sign up|create profile)$/i.test(label);
    const formRegistrationEvidence =
      /\b(create (an? )?account|creating (an? )?account|sign[ -]?up|signing up|register|registration|new account|create (your )?profile|become a member|set up (your )?account)\b/i.test(
        candidate.scopeText,
      );
    if (!strongLabel && !formRegistrationEvidence) {
      return { kind: "ambiguous", locator: controls.nth(candidate.index), label, confidence: 40 };
    }
    if (recognizedFieldCount >= 1) return { kind: "final", locator: controls.nth(candidate.index), label, confidence: 95 };
  }
  const ambiguous = candidates.find(
    (candidate) => candidate.insideForm && !candidate.disabled && /submit|finish|complete|join|enroll|apply|continue|register|sign up/i.test(candidate.text),
  );
  if (ambiguous) return { kind: "ambiguous", locator: controls.nth(ambiguous.index), label: ambiguous.text || "unlabeled control", confidence: 40 };
  return undefined;
}

async function findSignupEntryAction(page: Page): Promise<NavigationAction | undefined> {
  const controls = page.locator('a[href], button, input[type="button"]');
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const candidate = await control.evaluate((element) => ({
      text: ((element as HTMLInputElement).value || element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
      href: element instanceof HTMLAnchorElement ? element.href : "",
      disabled: (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true",
    }));
    if (candidate.disabled) continue;
    if (!/^(sign[ -]?up|register|registration|join now|create (an? )?account|create profile|become a member|enroll|get started)$/i.test(candidate.text)) continue;
    if (/\b(pay|payment|checkout|purchase|buy|donate|subscribe now|log[ -]?in|sign[ -]?in)\b/i.test(candidate.text)) continue;
    if (candidate.href) {
      let target: URL;
      let current: URL;
      try {
        target = new URL(candidate.href);
        current = new URL(page.url());
      } catch {
        continue;
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") continue;
      const sameSite = target.hostname === current.hostname || target.hostname.endsWith(`.${current.hostname}`) || current.hostname.endsWith(`.${target.hostname}`);
      if (!sameSite) continue;
      if (/\b(checkout|payment|billing|donate|cart)\b/i.test(`${target.pathname} ${target.search}`)) continue;
    }
    return { kind: "signup", locator: control, label: candidate.text, confidence: 95 };
  }
  return undefined;
}

async function pageLooksComplete(page: Page, hasVisibleProfileForm: boolean): Promise<boolean> {
  if (hasVisibleProfileForm || (await visibleValidationErrors(page))) return false;
  const text = (await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 20_000).toLowerCase();
  if (/email (is )?already (exists|registered|in use)|account already exists|registration (failed|rejected)|server error|unable to (register|create)|incomplete form/.test(text)) {
    return false;
  }
  return /thank you for (registering|signing up)|registration (is )?complete|account (has been )?created|successfully registered/.test(text);
}

export async function scanAndFillPage(
  page: Page,
  profile: PersonProfile,
  registry: FieldRegistry = getDefaultFieldRegistry(),
): Promise<PageScanResult> {
  const fields = await collectFields(page);
  const accountFlow = await classifyAccountFlow(page);
  const initialBlocker = await detectPageBlocker(page, fields, profile, accountFlow);
  if (initialBlocker) {
    return {
      success: false,
      filledFields: [],
      recognizedFieldCount: 0,
      visibleFieldCount: fields.length,
      accountFlow,
      humanHandoff: initialBlocker,
      stateHash: await currentPageState(page),
      phase: "BLOCKED",
    };
  }

  const fieldLocator = page.locator("input, textarea, select");
  const filledFields: string[] = [];
  const identityFieldsSeen: string[] = [];
  let recognizedFieldCount = 0;
  const unmappedRequired: FieldDescriptor[] = [];

  for (const descriptor of fields) {
    if (descriptor.disabled || descriptor.readOnly || descriptor.type === "checkbox" || descriptor.type === "radio" || descriptor.type === "file") continue;
    // Sensitive classification always executes before normal profile matching.
    const sensitive = detectRestrictedSensitiveField(descriptor);
    if (sensitive && sensitive.kind !== "password") {
      return {
        success: false,
        filledFields: [],
        recognizedFieldCount: 0,
        visibleFieldCount: fields.length,
        accountFlow,
        humanHandoff: { category: "REQUIRED_MANUAL_FIELD", reason: `Restricted ${sensitive.reason} requires operator input` },
        stateHash: await currentPageState(page),
        phase: "BLOCKED",
      };
    }
    const match = matchProfileField(descriptor, { registry, accountFlow });
    if (!match) {
      if (descriptor.required || descriptor.invalid) unmappedRequired.push(descriptor);
      continue;
    }
    recognizedFieldCount += 1;
    const value = profileValue(profile, match, descriptor);
    if (!value) {
      if (descriptor.required || descriptor.invalid) unmappedRequired.push(descriptor);
      continue;
    }
    if (descriptor.currentValue.trim()) {
      // A form is not safe just because a field has a value. If a pre-populated
      // field clearly belongs to someone else, stop and hand off rather than
      // submit stale data.
      if (prefilledValueConflicts(match.field, descriptor.currentValue, value)) {
        return {
          success: false,
          filledFields,
          recognizedFieldCount,
          visibleFieldCount: fields.length,
          accountFlow,
          humanHandoff: {
            category: "REQUIRED_MANUAL_FIELD",
            reason: `A prefilled ${match.field} field does not match the active client; left for operator review`,
          },
          stateHash: await currentPageState(page),
          identityFieldsSeen,
          phase: "BLOCKED",
        };
      }
      if (IDENTITY_FIELDS.has(match.field)) identityFieldsSeen.push(match.field);
      if (descriptor.invalid) unmappedRequired.push(descriptor);
      continue;
    }
    const locator = fieldLocator.nth(descriptor.domIndex);
    try {
      const filled = descriptor.tag === "select" ? await fillSelect(locator, value, match) : (await locator.fill(value), true);
      if (filled) {
        filledFields.push(match.field);
        if (IDENTITY_FIELDS.has(match.field)) identityFieldsSeen.push(match.field);
      } else if (descriptor.required) {
        unmappedRequired.push(descriptor);
      }
    } catch {
      if (descriptor.required || descriptor.invalid) unmappedRequired.push(descriptor);
    }
  }

  if (unmappedRequired.length > 0 || (await visibleValidationErrors(page))) {
    return {
      success: false,
      filledFields,
      recognizedFieldCount,
      visibleFieldCount: fields.length,
      accountFlow,
      humanHandoff: { category: "REQUIRED_MANUAL_FIELD", reason: "A required field or validation error has no permitted automatic resolution" },
      stateHash: await currentPageState(page),
      phase: "BLOCKED",
    };
  }

  const hasVisibleProfileForm = recognizedFieldCount > 0;
  if (await pageLooksComplete(page, hasVisibleProfileForm)) {
    return {
      success: true,
      filledFields,
      recognizedFieldCount,
      visibleFieldCount: fields.length,
      accountFlow,
      stateHash: await currentPageState(page),
      identityFieldsSeen,
      phase: "COMPLETE",
    };
  }
  const action = recognizedFieldCount > 0
    ? await findNavigationAction(page, recognizedFieldCount, accountFlow)
    : await findSignupEntryAction(page);
  const phase = action?.kind === "final"
    ? "FINAL_REGISTRATION_STEP"
    : recognizedFieldCount > 0
      ? "REGISTRATION_FORM"
      : "LANDING_OR_INTERMEDIATE";
  return {
    success: false,
    filledFields,
    recognizedFieldCount,
    visibleFieldCount: fields.length,
    accountFlow,
    ...(action ? { action } : {}),
    stateHash: await currentPageState(page),
    identityFieldsSeen,
    phase,
  };
}

export async function currentPageState(page: Page): Promise<string> {
  const state = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("input, textarea, select, button")]
      .filter((element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const box = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((element) => {
        const input = element as HTMLInputElement;
        return [element.tagName, input.type ?? "", input.name ?? "", input.id ?? "", element.textContent?.trim() ?? ""].join(":");
      });
    return `${location.origin}${location.pathname}|${document.title}|${controls.join("|")}`;
  });
  return pageStateHash(state);
}

export interface FinalSubmitRevalidation {
  ok: boolean;
  reason?: string;
}

/**
 * Re-read the LIVE form state immediately before the durable final-submit
 * boundary. The earlier scan's values are not trusted here: a password manager
 * or the operator may have changed a field, a blocker/iframe may have appeared,
 * and required fields may have been cleared. Any conflict blocks submission.
 */
export async function revalidateFinalSubmit(
  page: Page,
  profile: PersonProfile,
  registry: FieldRegistry = getDefaultFieldRegistry(),
): Promise<FinalSubmitRevalidation> {
  const fields = await collectFields(page);
  const accountFlow = await classifyAccountFlow(page);

  const blocker = await detectPageBlocker(page, fields, profile, accountFlow);
  if (blocker) return { ok: false, reason: `Blocker appeared before submit: ${blocker.reason}` };

  if (await visibleValidationErrors(page)) return { ok: false, reason: "Visible validation errors appeared before submit" };

  for (const descriptor of fields) {
    if (descriptor.disabled || descriptor.readOnly) continue;
    if (descriptor.type === "checkbox" || descriptor.type === "radio" || descriptor.type === "file") continue;
    const match = matchProfileField(descriptor, { registry, accountFlow });
    if (!match) {
      if ((descriptor.required || descriptor.invalid) && !descriptor.currentValue.trim()) {
        return { ok: false, reason: `Required field "${descriptor.name || descriptor.label || "unnamed"}" is empty before submit` };
      }
      continue;
    }
    const expected = profileValue(profile, match, descriptor);
    const current = descriptor.currentValue.trim();
    if (!current) {
      if (descriptor.required && expected) {
        return { ok: false, reason: `Recognised field ${match.field} was cleared before submit` };
      }
      continue;
    }
    if (expected && prefilledValueConflicts(match.field, current, expected)) {
      return { ok: false, reason: `Field ${match.field} no longer matches the active client just before submit` };
    }
  }
  return { ok: true };
}
