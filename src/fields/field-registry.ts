import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProfileField } from "../types/models.js";
import { normalizeText } from "../utils/text.js";

export type FieldSensitivity = "normal" | "personal" | "private" | "credential" | "restricted";
export type FieldTransform = "text" | "email" | "phone" | "state" | "postal-code" | "date-of-birth" | "annual-income" | "password";

export interface FieldRegistryEntry {
  profileField: string;
  aliases: string[];
  autofill: boolean;
  sensitivity: FieldSensitivity;
  transform: FieldTransform;
  contextRestrictions?: string[];
}

export interface FieldRegistry {
  version: number;
  fields: Record<string, FieldRegistryEntry>;
  restrictedAliases: string[];
}

const sensitivities = new Set<FieldSensitivity>(["normal", "personal", "private", "credential", "restricted"]);
const transforms = new Set<FieldTransform>(["text", "email", "phone", "state", "postal-code", "date-of-birth", "annual-income", "password"]);

export function validateFieldRegistry(value: unknown): FieldRegistry {
  if (!value || typeof value !== "object") throw new Error("Field registry must be a JSON object.");
  const candidate = value as Partial<FieldRegistry>;
  if (candidate.version !== 1 || !candidate.fields || typeof candidate.fields !== "object" || !Array.isArray(candidate.restrictedAliases)) {
    throw new Error("Field registry must use version 1 and include fields plus restrictedAliases.");
  }
  for (const [canonical, raw] of Object.entries(candidate.fields)) {
    if (!canonical.trim() || !raw || typeof raw !== "object") throw new Error(`Invalid field registry entry: ${canonical || "<blank>"}.`);
    const entry = raw as FieldRegistryEntry;
    if (typeof entry.profileField !== "string" || !entry.profileField.trim()) throw new Error(`${canonical} has an invalid profileField.`);
    if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
      throw new Error(`${canonical} must contain non-empty aliases.`);
    }
    if (typeof entry.autofill !== "boolean" || !sensitivities.has(entry.sensitivity) || !transforms.has(entry.transform)) {
      throw new Error(`${canonical} has invalid autofill, sensitivity, or transform metadata.`);
    }
    if (entry.sensitivity === "restricted" && entry.autofill) throw new Error(`${canonical} cannot enable autofill for restricted data.`);
  }
  if (candidate.restrictedAliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
    throw new Error("restrictedAliases must contain non-empty strings.");
  }
  return candidate as FieldRegistry;
}

export async function loadFieldRegistry(filePath: string): Promise<FieldRegistry> {
  return validateFieldRegistry(JSON.parse(await readFile(filePath, "utf8")));
}

export async function ensureFieldRegistry(projectRoot: string, targetPath: string): Promise<FieldRegistry> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await access(targetPath);
  } catch {
    await copyFile(path.join(projectRoot, "config", "field-registry.json"), targetPath);
  }
  return loadFieldRegistry(targetPath);
}

export async function initializeFieldRegistry(projectRoot: string, targetPath: string, overwrite = false): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  if (!overwrite) {
    try {
      await access(targetPath);
      return;
    } catch {
      // The registry does not exist yet.
    }
  }
  const source = await readFile(path.join(projectRoot, "config", "field-registry.json"), "utf8");
  validateFieldRegistry(JSON.parse(source));
  await writeFile(targetPath, source, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

export function registryEntryForHeader(registry: FieldRegistry, header: string): [string, FieldRegistryEntry] | undefined {
  const normalized = normalizeText(header);
  return Object.entries(registry.fields).find(
    ([canonical, entry]) => normalizeText(canonical) === normalized || entry.aliases.some((alias) => normalizeText(alias) === normalized),
  );
}

export function headerIsRestricted(registry: FieldRegistry, header: string): boolean {
  const normalized = normalizeText(header);
  return registry.restrictedAliases.some((alias) => {
    const token = normalizeText(alias);
    return normalized === token || normalized.includes(token);
  });
}
