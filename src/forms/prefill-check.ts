import { normalizeText } from "../utils/text.js";

/**
 * High-confidence detection that a *pre-populated* form field holds data that
 * does not belong to the active client. A conflict here must stop automatic
 * submission and hand off to a human — a form is not safe just because its
 * fields contain values.
 *
 * The checks are deliberately narrow: they only fire on clear identity
 * mismatches (email, name, phone, ZIP, state) so a legitimately prefilled field
 * that merely differs in formatting is not treated as a conflict.
 */

const US_STATES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id",
  illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la",
  maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh", "new jersey": "nj",
  "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd", ohio: "oh",
  oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt", virginia: "va",
  washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
  "district of columbia": "dc",
};

const digitsOnly = (value: string): string => value.replace(/\D+/g, "");
const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

function canonicalState(value: string): string {
  const normalized = normalizeText(value);
  if (US_STATES[normalized]) return US_STATES[normalized]!;
  if (normalized.length === 2 && Object.values(US_STATES).includes(normalized)) return normalized;
  return normalized;
}

export function prefilledValueConflicts(field: string, currentRaw: string, expectedRaw: string): boolean {
  const current = currentRaw.trim();
  const expected = expectedRaw.trim();
  if (!current || !expected) return false;

  switch (field) {
    case "email": {
      const c = current.toLowerCase();
      const e = expected.toLowerCase();
      return looksLikeEmail(c) && looksLikeEmail(e) && c !== e;
    }
    case "phone": {
      const c = digitsOnly(current);
      const e = digitsOnly(expected);
      return c.length >= 10 && e.length >= 10 && c.slice(-10) !== e.slice(-10);
    }
    case "zip": {
      const c = digitsOnly(current);
      const e = digitsOnly(expected);
      return c.length >= 5 && e.length >= 5 && c.slice(0, 5) !== e.slice(0, 5);
    }
    case "state":
      return canonicalState(current) !== canonicalState(expected);
    case "firstName":
    case "lastName":
    case "city": {
      const c = normalizeText(current);
      const e = normalizeText(expected);
      if (!c || !e) return false;
      return c !== e && !c.includes(e) && !e.includes(c);
    }
    case "dob":
    case "dobYear": {
      const c = digitsOnly(current);
      const e = digitsOnly(expected);
      return c.length >= 4 && e.length >= 4 && c !== e;
    }
    default:
      return false;
  }
}

/** Fields that count as a verified identity anchor for a safe automatic final submit. */
export const IDENTITY_FIELDS = new Set(["email", "firstName", "lastName"]);

export function hasIdentityAnchor(seen: ReadonlySet<string>): boolean {
  return seen.has("email") || (seen.has("firstName") && seen.has("lastName"));
}
