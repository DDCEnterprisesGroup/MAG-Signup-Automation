import { readFileSync } from "node:fs";
import path from "node:path";
import type { FieldRegistry, FieldRegistryEntry } from "../fields/field-registry.js";
import { validateFieldRegistry } from "../fields/field-registry.js";
import type { AccountFlowContext, PersonProfile, ProfileField } from "../types/models.js";
import { normalizeText } from "../utils/text.js";

export interface FieldDescriptor {
  domIndex: number;
  tag: "input" | "textarea" | "select";
  type: string;
  required: boolean;
  invalid: boolean;
  disabled: boolean;
  readOnly: boolean;
  currentValue: string;
  label: string;
  placeholder: string;
  name: string;
  id: string;
  autocomplete: string;
  ariaLabel: string;
  nearbyText: string;
}

export interface FieldMatch {
  field: string;
  confidence: number;
  evidence: string;
  transform: FieldRegistryEntry["transform"];
}

export interface SensitiveFieldMatch {
  reason: string;
  kind: "restricted" | "password" | "verification";
}

export interface FieldMatchOptions {
  registry?: FieldRegistry;
  accountFlow?: AccountFlowContext;
}

let defaultRegistry: FieldRegistry | undefined;

export function getDefaultFieldRegistry(): FieldRegistry {
  defaultRegistry ??= validateFieldRegistry(
    JSON.parse(readFileSync(path.resolve(process.cwd(), "config", "field-registry.json"), "utf8")),
  );
  return defaultRegistry;
}

const restrictedSensitivePatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(ssn|social security( number| no)?)\b/, reason: "Social Security information" },
  {
    pattern: /\b(tin|tax( payer)? (id|identification)( number)?|taxpayer identification number|ein|employer identification number)\b/,
    reason: "tax identification information",
  },
  {
    pattern:
      /\b(government( issued)? (id|identification)|national id|identity document|driver s? licen[cs]e( number)?|passport( number)?)\b/,
    reason: "government identity information",
  },
  {
    pattern: /\b(bank( account)?|checking account|savings account|account number|routing( number)?|routing transit number|aba( routing)? number|iban|swift code|bic code)\b/,
    reason: "banking information",
  },
  {
    pattern: /\b(card|credit card|debit card|payment card|card number|cardholder|cvv|cvc|card security code|card expiration|card expiry)\b/,
    reason: "payment-card information",
  },
  { pattern: /\b(passcode|pass phrase|pin|personal identification number)\b/, reason: "password or PIN" },
  {
    pattern: /\b(security (answer|question)|secret (answer|question)|mother s maiden name)\b/,
    reason: "security question or answer",
  },
  { pattern: /\b(biometric|fingerprint|face scan)\b/, reason: "biometric information" },
];

const verificationPattern = /\b(one time code|one time password|verification code|authentication code|otp)\b/;
const autocompleteMap: Record<string, ProfileField> = {
  "given-name": "firstName",
  "family-name": "lastName",
  tel: "phone",
  email: "email",
  "street-address": "address",
  "address-line1": "address",
  "address-level2": "city",
  "address-level1": "state",
  "postal-code": "zip",
  bday: "dob",
  "bday-month": "dobMonth",
  "bday-day": "dobDay",
  "bday-year": "dobYear",
};

export function descriptorText(descriptor: FieldDescriptor): string {
  return normalizeText(
    [descriptor.label, descriptor.placeholder, descriptor.name, descriptor.id, descriptor.autocomplete, descriptor.ariaLabel, descriptor.nearbyText].join(
      " ",
    ),
  );
}

export function detectRestrictedSensitiveField(descriptor: FieldDescriptor): SensitiveFieldMatch | null {
  const type = descriptor.type.trim().toLowerCase();
  const autocomplete = normalizeText(descriptor.autocomplete).replaceAll(" ", "-");
  if (type === "password" || autocomplete === "current-password" || autocomplete === "new-password") {
    return { reason: "password credential", kind: "password" };
  }
  if (autocomplete === "one-time-code") return { reason: "verification code", kind: "verification" };
  if (autocomplete.startsWith("cc-")) return { reason: "payment-card information", kind: "restricted" };

  const context = descriptorText(descriptor);
  if (verificationPattern.test(context)) return { reason: "verification code", kind: "verification" };
  for (const restricted of restrictedSensitivePatterns) {
    if (restricted.pattern.test(context)) return { reason: restricted.reason, kind: "restricted" };
  }
  return null;
}

function directDobPart(descriptor: FieldDescriptor): ProfileField | undefined {
  const primary = normalizeText([descriptor.label, descriptor.ariaLabel, descriptor.name, descriptor.id, descriptor.placeholder].join(" "));
  const all = descriptorText(descriptor);
  const birthContext = /\b(dob|date of birth|birth date|birthdate|birthday|bday)\b/.test(all);
  if (!birthContext) return undefined;
  if (/\b(mm dd yyyy|yyyy mm dd)\b/.test(primary)) return undefined;
  if (/\b(date of birth|birth date|birthdate|birthday|dob)\b/.test(primary) && !/\b(month|day|year)\b/.test(primary)) return undefined;
  if (/\b(month|mm|bday month|dob month)\b/.test(primary)) return "dobMonth";
  if (/\b(day|dd|bday day|dob day)\b/.test(primary)) return "dobDay";
  if (/\b(year|yyyy|bday year|dob year)\b/.test(primary)) return "dobYear";
  return undefined;
}

function matchesAlias(text: string, alias: string): boolean {
  const normalizedAlias = normalizeText(alias);
  if (!normalizedAlias) return false;
  return text === normalizedAlias || text.includes(` ${normalizedAlias} `) || text.startsWith(`${normalizedAlias} `) || text.endsWith(` ${normalizedAlias}`);
}

export function matchProfileField(descriptor: FieldDescriptor, options: FieldMatchOptions = {}): FieldMatch | null {
  const sensitive = detectRestrictedSensitiveField(descriptor);
  if (sensitive?.kind === "restricted" || sensitive?.kind === "verification") return null;
  if (sensitive?.kind === "password" && options.accountFlow !== "registration") return null;

  const registry = options.registry ?? getDefaultFieldRegistry();
  const autocomplete = normalizeText(descriptor.autocomplete).replaceAll(" ", "-");
  if (sensitive?.kind === "password") {
    const entry = registry.fields.PASSWORD;
    if (!entry?.autofill) return null;
    return { field: "password", confidence: 100, evidence: "registration password policy", transform: entry.transform };
  }

  const dobPart = directDobPart(descriptor);
  if (dobPart) {
    const entry = registry.fields.DOB;
    if (entry?.autofill) return { field: dobPart, confidence: 95, evidence: "explicit DOB component", transform: entry.transform };
  }

  const autocompleteField = autocompleteMap[autocomplete];
  if (autocompleteField) {
    const canonicalEntry = Object.values(registry.fields).find((entry) =>
      autocompleteField.startsWith("dob") ? entry.profileField === "dob" : entry.profileField === autocompleteField,
    );
    if (canonicalEntry?.autofill) {
      return { field: autocompleteField, confidence: 100, evidence: "autocomplete", transform: canonicalEntry.transform };
    }
  }

  const context = descriptorText(descriptor);
  if (/\b(monthly|weekly|household|net income|business revenue|employer revenue)\b/.test(context)) {
    if (/\bincome|earnings|revenue\b/.test(context)) return null;
  }
  if (/\bemployer|company name|organization\b/.test(context) && !/\boccupation|profession|job title|work title\b/.test(context)) return null;

  const sources = [
    [normalizeText(descriptor.label), 70, "label"],
    [normalizeText(descriptor.ariaLabel), 65, "aria-label"],
    [normalizeText(`${descriptor.name} ${descriptor.id}`), 60, "name/id"],
    [normalizeText(descriptor.placeholder), 55, "placeholder"],
    [normalizeText(descriptor.nearbyText), 20, "nearby text"],
  ] as const;
  const scores = new Map<string, { entry: FieldRegistryEntry; score: number; evidence: string[] }>();
  for (const [canonical, entry] of Object.entries(registry.fields)) {
    if (entry.autofill && entry.sensitivity !== "restricted" && entry.profileField !== "password") {
      scores.set(canonical, { entry, score: 0, evidence: [] });
    }
  }
  for (const [text, weight, evidence] of sources) {
    if (!text) continue;
    for (const score of scores.values()) {
      if (score.entry.aliases.some((alias) => matchesAlias(text, alias))) {
        score.score += weight;
        score.evidence.push(evidence);
      }
    }
  }
  if (descriptor.type === "email") {
    const email = [...scores.values()].find((score) => score.entry.profileField === "email");
    if (email) {
      email.score += 80;
      email.evidence.push("input type");
    }
  }
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 55 || (second && best.score - second.score < 15)) return null;
  return {
    field: best.entry.profileField,
    confidence: Math.min(100, best.score),
    evidence: best.evidence.join(", "),
    transform: best.entry.transform,
  };
}

export interface NormalizedDob {
  year: string;
  month: string;
  day: string;
  iso: string;
  display: string;
}

export function normalizeDob(rawValue: string): NormalizedDob | undefined {
  const value = rawValue.trim();
  const match = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/.exec(value);
  if (!match) return undefined;
  let year: number;
  let month: number;
  let day: number;
  if ((match[1]?.length ?? 0) === 4) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  }
  if (year < 1900 || year > new Date().getUTCFullYear() || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  const paddedMonth = String(month).padStart(2, "0");
  const paddedDay = String(day).padStart(2, "0");
  return { year: String(year), month: paddedMonth, day: paddedDay, iso: `${year}-${paddedMonth}-${paddedDay}`, display: `${paddedMonth}/${paddedDay}/${year}` };
}

export function profileValue(profile: PersonProfile, match: FieldMatch, descriptor: FieldDescriptor): string {
  if (match.field === "dob" || match.field === "dobMonth" || match.field === "dobDay" || match.field === "dobYear") {
    const dob = normalizeDob(profile.dob);
    if (!dob) return "";
    if (match.field === "dobMonth") return dob.month;
    if (match.field === "dobDay") return dob.day;
    if (match.field === "dobYear") return dob.year;
    return descriptor.type === "date" ? dob.iso : dob.display;
  }
  if (match.field === "annualIncome") return profile.annualIncome.replace(/[^0-9.-]/g, "");
  const direct = profile[match.field as keyof PersonProfile];
  return typeof direct === "string" ? direct : profile.dynamicFields[match.field] ?? "";
}
