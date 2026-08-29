import type { Site } from "../types/models.js";
import { normalizeUrl } from "../utils/text.js";

export type SiteRowClass = "ACTUAL SITE" | "PARTIAL SITE" | "RESERVED" | "INVALID";
export type DuplicateClass = "HIGH-CONFIDENCE DUPLICATE" | "POSSIBLE DUPLICATE" | "DISTINCT PROGRAM" | "NOT DUPLICATE";

export interface SiteInventoryRow {
  worksheetRow: number;
  siteId: string;
  siteName: string;
  originalUrl: string;
  normalizedUrl: string;
  domain: string;
  rowClass: SiteRowClass;
  duplicateGroupId: string;
  duplicateClassification: DuplicateClass;
  canonicalRecord: string;
  recommendedAction: string;
  reason: string;
}

export interface SiteInventoryReport {
  generatedAt: string;
  formattedRows: number;
  reservedRows: number;
  actualSites: number;
  partialSites: number;
  invalidSites: number;
  recordsWithUrls: number;
  recordsMissingUrls: number;
  enabledRecords: number;
  automationReady: number;
  uniquePrograms: number;
  highConfidenceDuplicates: number;
  possibleDuplicates: number;
  distinctSameDomainPrograms: number;
  rows: SiteInventoryRow[];
}

export function siteRowClass(site: Site): SiteRowClass {
  const name = site.name.trim();
  const rawUrl = site.signupUrl.trim();
  const operationalMetadata = Boolean(site.finalUrl.trim() || site.notes.trim() || site.lastChecked.trim()) ||
    !["", "NOT CHECKED"].includes(site.status.trim().toUpperCase());
  if (!name && !rawUrl && !operationalMetadata) return "RESERVED";
  if (rawUrl) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) ? "ACTUAL SITE" : "INVALID";
    } catch { return "INVALID"; }
  }
  return name ? "PARTIAL SITE" : "INVALID";
}

function destinationParts(rawUrl: string): { normalized: string; domain: string; path: string } {
  try {
    const normalized = normalizeUrl(rawUrl).replace(/^http:/i, "https:");
    const url = new URL(normalized);
    return { normalized, domain: url.hostname, path: `${url.hostname}${url.pathname}`.toLowerCase() };
  } catch { return { normalized: "", domain: "", path: "" }; }
}

export function buildSiteInventory(sites: readonly Site[], formattedRows: number): SiteInventoryReport {
  const rows: SiteInventoryRow[] = sites.map((site) => {
    const parts = destinationParts(site.signupUrl);
    return { worksheetRow: site.rowNumber, siteId: site.id, siteName: site.name, originalUrl: site.signupUrl,
      normalizedUrl: parts.normalized, domain: parts.domain, rowClass: siteRowClass(site), duplicateGroupId: "",
      duplicateClassification: "NOT DUPLICATE", canonicalRecord: "", recommendedAction: "KEEP", reason: "No duplicate evidence." };
  });
  const actual = rows.filter((row) => row.rowClass === "ACTUAL SITE");
  const exactGroups = new Map<string, SiteInventoryRow[]>();
  const pathGroups = new Map<string, SiteInventoryRow[]>();
  const domainGroups = new Map<string, SiteInventoryRow[]>();
  for (const row of actual) {
    const parts = destinationParts(row.originalUrl);
    for (const [map, key] of [[exactGroups, parts.normalized], [pathGroups, parts.path], [domainGroups, parts.domain]] as const) {
      if (!key) continue; const group = map.get(key) ?? []; group.push(row); map.set(key, group);
    }
  }
  let groupNumber = 0;
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue; groupNumber += 1; const canonical = group[0]!;
    for (const row of group) {
      row.duplicateGroupId = `D${String(groupNumber).padStart(4, "0")}`; row.canonicalRecord = canonical.siteId;
      if (row === canonical) { row.reason = "Canonical record for the same normalized signup destination."; continue; }
      row.duplicateClassification = "HIGH-CONFIDENCE DUPLICATE"; row.recommendedAction = "DISABLE";
      row.reason = "Same normalized signup destination; only harmless tracking/protocol/trailing-slash differences.";
    }
  }
  for (const group of pathGroups.values()) {
    const candidates = group.filter((row) => row.duplicateClassification === "NOT DUPLICATE");
    if (candidates.length < 2 || new Set(candidates.map((row) => row.normalizedUrl)).size < 2) continue;
    groupNumber += 1;
    for (const row of candidates) {
      row.duplicateGroupId = `D${String(groupNumber).padStart(4, "0")}`; row.duplicateClassification = "POSSIBLE DUPLICATE";
      row.canonicalRecord = candidates[0]!.siteId; row.recommendedAction = "REVIEW";
      row.reason = "Same host and path with different material query parameters; program identity requires review.";
    }
  }
  for (const group of domainGroups.values()) {
    const candidates = group.filter((row) => row.duplicateClassification === "NOT DUPLICATE");
    if (candidates.length < 2) continue;
    for (const row of candidates) {
      row.duplicateClassification = "DISTINCT PROGRAM"; row.recommendedAction = "KEEP";
      row.reason = "Same domain but a distinct signup path/destination.";
    }
  }
  const highConfidence = rows.filter((row) => row.duplicateClassification === "HIGH-CONFIDENCE DUPLICATE").length;
  return { generatedAt: new Date().toISOString(), formattedRows, reservedRows: rows.filter((row) => row.rowClass === "RESERVED").length,
    actualSites: actual.length, partialSites: rows.filter((row) => row.rowClass === "PARTIAL SITE").length,
    invalidSites: rows.filter((row) => row.rowClass === "INVALID").length, recordsWithUrls: actual.length,
    recordsMissingUrls: rows.filter((row) => row.rowClass === "PARTIAL SITE").length,
    enabledRecords: actual.filter((row) => sites.find((site) => site.id === row.siteId)?.active).length,
    automationReady: actual.filter((row) => sites.find((site) => site.id === row.siteId)?.active && row.duplicateClassification !== "HIGH-CONFIDENCE DUPLICATE").length,
    uniquePrograms: actual.length - highConfidence, highConfidenceDuplicates: highConfidence,
    possibleDuplicates: rows.filter((row) => row.duplicateClassification === "POSSIBLE DUPLICATE").length,
    distinctSameDomainPrograms: rows.filter((row) => row.duplicateClassification === "DISTINCT PROGRAM").length, rows };
}
