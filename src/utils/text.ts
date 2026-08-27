import { createHash } from "node:crypto";

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function cleanCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "w" in value && typeof value.w === "string") return value.w.trim();
  return String(value).trim();
}

export function normalizeUrl(rawUrl: string): string {
  const candidate = rawUrl.trim();
  if (!candidate) return "";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const url = new URL(withProtocol);
  url.hash = "";
  url.username = "";
  url.password = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of sorted) {
    if (!/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.append(key, value);
  }
  return url.toString();
}

export function safeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl.replace(/[?#].*$/, "");
  }
}

export function sameSiteHost(a: string, b: string): boolean {
  try {
    const hostA = new URL(a).hostname.toLowerCase().replace(/^www\./, "");
    const hostB = new URL(b).hostname.toLowerCase().replace(/^www\./, "");
    return hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`);
  } catch {
    return false;
  }
}

export function pageStateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "unknown";
}

export function appendNote(existing: string, addition: string, limit = 1000): string {
  const combined = [existing.trim(), addition.trim()].filter(Boolean).join(" | ");
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}
