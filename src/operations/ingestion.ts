import type { SignupIntake } from "../types/models.js";

export interface IngestionEnvelope extends SignupIntake { source?: string; }
export interface ParsedIngestion { records: IngestionEnvelope[]; format: "json" | "csv"; }

const aliases: Record<string, keyof IngestionEnvelope> = {
  requestid: "requestId", request_id: "requestId", first: "firstName", firstname: "firstName", first_name: "firstName",
  last: "lastName", lastname: "lastName", last_name: "lastName", email: "email", phone: "phone", address: "address",
  city: "city", state: "state", zip: "zip", zipcode: "zip", postalcode: "zip", dob: "dob", occupation: "occupation",
  annualincome: "annualIncome", annual_income: "annualIncome", "password": "password", source: "source",
};

function normalizeKeys(record: Record<string, unknown>): IngestionEnvelope {
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.trim().toLowerCase().replace(/[ -]+/g, "_");
    const target = aliases[key] ?? aliases[key.replaceAll("_", "")];
    if (target && rawValue !== undefined && rawValue !== null) normalized[target] = String(rawValue).trim();
  }
  if (normalized.email) normalized.email = normalized.email.toLowerCase();
  return normalized as unknown as IngestionEnvelope;
}

function csvRows(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && quoted && value[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      row.push(cell); if (row.some((item) => item.trim())) rows.push(row); row = []; cell = "";
    } else cell += character;
  }
  row.push(cell); if (row.some((item) => item.trim())) rows.push(row);
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  return rows;
}

export function parseIngestionFile(contents: string, extension: string): ParsedIngestion {
  if (extension.toLowerCase() === ".csv") {
    const rows = csvRows(contents);
    const headers = rows.shift()?.map((value) => value.trim()) ?? [];
    if (headers.length === 0) throw new Error("CSV must include a header row.");
    return { format: "csv", records: rows.map((values) => normalizeKeys(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])))) };
  }
  const parsed = JSON.parse(contents) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.some((value) => !value || typeof value !== "object" || Array.isArray(value))) throw new Error("JSON must be an object or array of objects.");
  return { format: "json", records: values.map((value) => normalizeKeys(value as Record<string, unknown>)) };
}

export function validateIngestionRecord(record: IngestionEnvelope): string[] {
  const errors: string[] = [];
  for (const field of ["requestId", "firstName", "lastName", "email"] as const) if (!record[field]?.trim()) errors.push(`${field} is required`);
  if (record.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) errors.push("email is invalid");
  return errors;
}
