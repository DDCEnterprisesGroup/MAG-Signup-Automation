import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { FieldRegistry } from "../fields/field-registry.js";
import { headerIsRestricted, registryEntryForHeader } from "../fields/field-registry.js";
import type {
  AttemptRecord,
  AttemptStatus,
  AttemptUpdate,
  ErrorCategory,
  PersonProfile,
  PersonProgress,
  PersonSummary,
  ReconciliationReport,
  SignupIntake,
  Site,
  SiteIssue,
} from "../types/models.js";
import { appendNote, normalizeUrl, safeUrl } from "../utils/text.js";
import { siteRowClass } from "../operations/site-inventory.js";

const SHEETS = {
  sites: "Sheet 1 Sites",
  people: "Sheet 2 People",
  results: "Sheet 3 Results",
  issues: "Sheet 4 Site Issues",
} as const;

const REQUIRED_HEADERS: Record<string, string[]> = {
  [SHEETS.sites]: ["SITE ID", "SITE NAME", "SIGNUP URL", "ACTIVE", "SITE STATUS", "LAST CHECKED", "FINAL URL", "NOTES"],
  [SHEETS.people]: [
    "ID",
    "FIRST NAME/GIVEN NAME",
    "LAST NAME",
    "PHONE",
    "EMAIL",
    "ADDRESS",
    "CITY",
    "STATE",
    "ZIP",
    "STATUS",
    "CURRENT SITE ID",
    "LAST UPDATED",
  ],
  [SHEETS.results]: [
    "ID",
    "NAME",
    "DATE ATTEMPTED",
    "SITES ATTEMPTED",
    "PASSED",
    "FAILED",
    "HUMAN REVIEW",
    "ATTEMPT ID",
    "PERSON ID",
    "SITE ID",
    "ATTEMPT DATE/TIME",
    "STATUS",
    "FORM STEP",
    "LAST URL",
    "ERROR TYPE",
    "RETRY ELIGIBLE",
    "NOTES",
  ],
  [SHEETS.issues]: [
    "SITE ID",
    "SITE NAME",
    "URL",
    "DATE CHECKED",
    "ISSUE TYPE",
    "HTTP STATUS",
    "REDIRECT URL",
    "GLOBAL STATUS",
    "NOTES",
  ],
};

const PEOPLE_SYSTEM_HEADERS = new Set(["ID", "STATUS", "CURRENT SITE ID", "LAST UPDATED"]);
const PEOPLE_PROFILE_HEADERS = [
  "FIRST NAME/GIVEN NAME",
  "LAST NAME",
  "PHONE",
  "EMAIL",
  "ADDRESS",
  "CITY",
  "STATE",
  "ZIP",
  "DOB",
  "OCCUPATION",
  "ANNUAL INCOME",
  "PASSWORD",
] as const;

const ATTEMPT_STATUS_SET = new Set<AttemptStatus>([
  "IN PROGRESS",
  "COMPLETED",
  "WAITING FOR HUMAN",
  "FAILED",
  "SITE INVALID",
  "TEMP FAILURE",
]);

type CellValue = string | number;
type SheetValues = Map<string, string>;

interface IssueRow extends SiteIssue {
  rowNumber: number;
}

function columnLetter(zeroBasedColumn: number): string {
  let column = zeroBasedColumn + 1;
  let result = "";
  while (column > 0) {
    const remainder = (column - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    column = Math.floor((column - 1) / 26);
  }
  return result;
}

function cellValue(sheet: SheetValues, row: number, column: number): string {
  return sheet.get(`${columnLetter(column - 1)}${row}`)?.trim() ?? "";
}

function headerMap(sheet: SheetValues): Map<string, number> {
  const result = new Map<string, number>();
  for (let column = 1; column <= 256; column += 1) {
    const value = cellValue(sheet, 1, column).toUpperCase();
    if (value) result.set(value, column);
  }
  return result;
}

function headerColumn(headers: Map<string, number>, name: string): number {
  return headers.get(name) ?? 0;
}

function valueByHeader(sheet: SheetValues, headers: Map<string, number>, row: number, name: string): string {
  const column = headerColumn(headers, name);
  return column ? cellValue(sheet, row, column) : "";
}

function assertSchema(sheets: Map<string, SheetValues>): void {
  const expectedNames = Object.values(SHEETS);
  if (sheets.size !== expectedNames.length || expectedNames.some((name) => !sheets.has(name))) {
    throw new Error(`Workbook must contain exactly these sheets: ${expectedNames.join(", ")}.`);
  }
  for (const sheetName of expectedNames) {
    const sheet = sheets.get(sheetName);
    if (!sheet) throw new Error(`Missing worksheet: ${sheetName}`);
    const headers = new Set(headerMap(sheet).keys());
    const missing = REQUIRED_HEADERS[sheetName]?.filter((header) => !headers.has(header)) ?? [];
    if (missing.length > 0) throw new Error(`${sheetName} is missing headers: ${missing.join(", ")}.`);
  }
}

function lastRow(sheet: SheetValues): number {
  return Math.max(1, ...[...sheet.keys()].map((address) => Number.parseInt(address.match(/\d+$/)?.[0] ?? "1", 10)));
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&amp;", "&");
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((match) =>
    [...(match[1] ?? "").matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
      .map((text) => decodeXml(text[1] ?? ""))
      .join(""),
  );
}

export function parseWorksheetXml(xml: string, sharedStrings: string[] = []): SheetValues {
  const values: SheetValues = new Map();
  const cells = xml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g);
  for (const match of cells) {
    const body = match[2];
    if (body === undefined) continue;
    const attributes = match[1] ?? "";
    const address = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
    if (!address) continue;
    const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "";
    let raw = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1] ?? "";
    if (type === "inlineStr") {
      raw = [...body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((text) => text[1] ?? "").join("");
    }
    let value = decodeXml(raw);
    if (type === "s") value = sharedStrings[Number.parseInt(value, 10)] ?? "";
    else if (!type && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) value = String(Number(value));
    if (value !== "") values.set(address, value);
  }
  return values;
}

function attemptStatus(value: string): AttemptStatus {
  const normalized = value.trim().toUpperCase() as AttemptStatus;
  return ATTEMPT_STATUS_SET.has(normalized) ? normalized : "FAILED";
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnNumber(address: string): number {
  const letters = address.match(/^[A-Z]+/)?.[0] ?? "A";
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function sheetPrefix(xml: string): string {
  return /<([A-Za-z_][\w.-]*:)?worksheet\b/.exec(xml)?.[1] ?? "";
}

function makeCellXml(prefix: string, address: string, value: CellValue): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<${prefix}c r="${address}"><${prefix}v>${value}</${prefix}v></${prefix}c>`;
  }
  return `<${prefix}c r="${address}" t="str"><${prefix}v>${xmlEscape(String(value))}</${prefix}v></${prefix}c>`;
}

export function setCellInWorksheetXml(xml: string, address: string, value: CellValue): string {
  const rowNumber = Number.parseInt(address.match(/\d+$/)?.[0] ?? "0", 10);
  if (!rowNumber) throw new Error(`Invalid cell address: ${address}`);
  const prefix = sheetPrefix(xml);
  const escapedPrefix = prefix.replace(":", "\\:");
  const rowPattern = new RegExp(`<${escapedPrefix}row\\b([^>]*\\br="${rowNumber}"[^>]*)>([\\s\\S]*?)<\\/${escapedPrefix}row>`);
  const rowMatch = rowPattern.exec(xml);
  const newCell = makeCellXml(prefix, address, value);

  if (!rowMatch) {
    const newRow = `<${prefix}row r="${rowNumber}">${newCell}</${prefix}row>`;
    const closeSheetData = `</${prefix}sheetData>`;
    if (!xml.includes(closeSheetData)) throw new Error("Worksheet XML has no sheetData element.");
    const rows = [...xml.matchAll(new RegExp(`<${escapedPrefix}row\\b[^>]*\\br="(\\d+)"`, "g"))];
    const nextRow = rows.find((match) => Number.parseInt(match[1] ?? "0", 10) > rowNumber);
    if (nextRow?.index !== undefined) {
      return `${xml.slice(0, nextRow.index)}${newRow}${xml.slice(nextRow.index)}`;
    }
    return xml.replace(closeSheetData, `${newRow}${closeSheetData}`);
  }

  const fullRow = rowMatch[0];
  const rowAttributes = rowMatch[1] ?? "";
  let cells = rowMatch[2] ?? "";
  const cellPattern = new RegExp(
    `<${escapedPrefix}c\\b(?=[^>]*\\br="${address}")(?:(?:[^>]*?\\/>)|(?:[^>]*?>[\\s\\S]*?<\\/${escapedPrefix}c>))`,
  );
  if (cellPattern.test(cells)) {
    cells = cells.replace(cellPattern, newCell);
  } else {
    const allCells = [...cells.matchAll(new RegExp(`<${escapedPrefix}c\\b[^>]*\\br="([A-Z]+\\d+)"[^>]*>`, "g"))];
    const nextCell = allCells.find((match) => columnNumber(match[1] ?? "A1") > columnNumber(address));
    if (nextCell?.index !== undefined) {
      cells = `${cells.slice(0, nextCell.index)}${newCell}${cells.slice(nextCell.index)}`;
    } else {
      cells = `${cells}${newCell}`;
    }
  }
  return xml.replace(fullRow, `<${prefix}row${rowAttributes}>${cells}</${prefix}row>`);
}

function makeAttemptId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `A-${stamp}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function nextDurableId(prefix: "P" | "S", ids: Iterable<string>): string {
  let maximum = 0;
  for (const id of ids) {
    const match = new RegExp(`^${prefix}(\\d+)$`, "i").exec(id.trim());
    if (match) maximum = Math.max(maximum, Number.parseInt(match[1] ?? "0", 10));
  }
  return `${prefix}${String(maximum + 1).padStart(4, "0")}`;
}

function contentHash(values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

interface ReconciliationState {
  version: 1;
  people: Record<string, string>;
  sites: Record<string, string>;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class WorkbookStore {
  private zip!: JSZip;
  private sheetPaths = new Map<string, string>();
  private sheetXml = new Map<string, string>();
  private sheetValues = new Map<string, SheetValues>();
  private lockHandle: FileHandle | undefined;
  private readonly lockPath: string;
  private readonly backupPath: string;
  private sites: Site[] = [];
  private people: PersonProfile[] = [];
  private attempts: AttemptRecord[] = [];
  private issues: IssueRow[] = [];
  private summaryRows = new Map<string, number>();
  private summaries = new Map<string, PersonSummary>();
  private checkpointQueue: Promise<void> = Promise.resolve();

  constructor(readonly workbookPath: string) {
    this.lockPath = `${workbookPath}.lock`;
    this.backupPath = `${workbookPath}.bak`;
  }

  async open(): Promise<void> {
    await mkdir(path.dirname(this.workbookPath), { recursive: true });
    await this.acquireLock();
    try {
      await this.load();
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      this.lockHandle = await open(this.lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let stale = false;
      try {
        const metadata = JSON.parse(await readFile(this.lockPath, "utf8")) as { pid?: number };
        stale = !metadata.pid || !processExists(metadata.pid);
      } catch {
        stale = true;
      }
      if (!stale) {
        throw new Error(`Workbook is already in use by another automation process (${this.lockPath}).`);
      }
      await rm(this.lockPath, { force: true });
      this.lockHandle = await open(this.lockPath, "wx");
    }
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  }

  private async load(): Promise<void> {
    const buffer = await readFile(this.workbookPath);
    this.zip = await JSZip.loadAsync(buffer);
    await this.loadSheetPaths();
    const sharedStringsXml = await this.zip.file("xl/sharedStrings.xml")?.async("string");
    const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];
    this.sheetValues.clear();
    for (const [sheetName, xml] of this.sheetXml.entries()) this.sheetValues.set(sheetName, parseWorksheetXml(xml, sharedStrings));
    assertSchema(this.sheetValues);
    this.loadRows();
  }

  private async loadSheetPaths(): Promise<void> {
    const workbookXml = await this.zip.file("xl/workbook.xml")?.async("string");
    const relationshipsXml = await this.zip.file("xl/_rels/workbook.xml.rels")?.async("string");
    if (!workbookXml || !relationshipsXml) throw new Error("Workbook OOXML relationships are missing.");

    const relationshipTargets = new Map<string, string>();
    for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
      const attributes = match[1] ?? "";
      const id = /\bId="([^"]+)"/.exec(attributes)?.[1];
      const target = /\bTarget="([^"]+)"/.exec(attributes)?.[1];
      if (!id || !target) continue;
      const normalized = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`;
      relationshipTargets.set(id, normalized);
    }

    for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/>/g)) {
      const name = match[1];
      const relationshipId = match[2];
      if (!name || !relationshipId) continue;
      const target = relationshipTargets.get(relationshipId);
      if (target) this.sheetPaths.set(name, target);
    }

    for (const sheetName of Object.values(SHEETS)) {
      const sheetPath = this.sheetPaths.get(sheetName);
      if (!sheetPath) throw new Error(`Could not resolve OOXML path for ${sheetName}.`);
      const xml = await this.zip.file(sheetPath)?.async("string");
      if (!xml) throw new Error(`Missing worksheet XML for ${sheetName}.`);
      this.sheetXml.set(sheetName, xml);
    }
  }

  private loadRows(): void {
    const sitesSheet = this.sheetValues.get(SHEETS.sites);
    const peopleSheet = this.sheetValues.get(SHEETS.people);
    const resultsSheet = this.sheetValues.get(SHEETS.results);
    const issuesSheet = this.sheetValues.get(SHEETS.issues);
    if (!sitesSheet || !peopleSheet || !resultsSheet || !issuesSheet) throw new Error("Workbook schema changed while loading.");

    const siteHeaders = headerMap(sitesSheet);
    const peopleHeaders = headerMap(peopleSheet);
    this.sites = [];
    for (let row = 2; row <= lastRow(sitesSheet); row += 1) {
      const id = valueByHeader(sitesSheet, siteHeaders, row, "SITE ID");
      if (!id) continue;
      this.sites.push({
        rowNumber: row,
        id,
        name: valueByHeader(sitesSheet, siteHeaders, row, "SITE NAME"),
        signupUrl: valueByHeader(sitesSheet, siteHeaders, row, "SIGNUP URL"),
        active: valueByHeader(sitesSheet, siteHeaders, row, "ACTIVE").toUpperCase() === "YES",
        status: valueByHeader(sitesSheet, siteHeaders, row, "SITE STATUS"),
        lastChecked: valueByHeader(sitesSheet, siteHeaders, row, "LAST CHECKED"),
        finalUrl: valueByHeader(sitesSheet, siteHeaders, row, "FINAL URL"),
        notes: valueByHeader(sitesSheet, siteHeaders, row, "NOTES"),
      });
    }

    this.people = [];
    for (let row = 2; row <= lastRow(peopleSheet); row += 1) {
      const id = valueByHeader(peopleSheet, peopleHeaders, row, "ID");
      if (!id) continue;
      this.people.push({
        rowNumber: row,
        id,
        firstName: valueByHeader(peopleSheet, peopleHeaders, row, "FIRST NAME/GIVEN NAME"),
        lastName: valueByHeader(peopleSheet, peopleHeaders, row, "LAST NAME"),
        phone: valueByHeader(peopleSheet, peopleHeaders, row, "PHONE"),
        email: valueByHeader(peopleSheet, peopleHeaders, row, "EMAIL"),
        address: valueByHeader(peopleSheet, peopleHeaders, row, "ADDRESS"),
        city: valueByHeader(peopleSheet, peopleHeaders, row, "CITY"),
        state: valueByHeader(peopleSheet, peopleHeaders, row, "STATE"),
        zip: valueByHeader(peopleSheet, peopleHeaders, row, "ZIP"),
        dob: valueByHeader(peopleSheet, peopleHeaders, row, "DOB"),
        occupation: valueByHeader(peopleSheet, peopleHeaders, row, "OCCUPATION"),
        annualIncome: valueByHeader(peopleSheet, peopleHeaders, row, "ANNUAL INCOME"),
        password: valueByHeader(peopleSheet, peopleHeaders, row, "PASSWORD"),
        dynamicFields: {},
        status: valueByHeader(peopleSheet, peopleHeaders, row, "STATUS"),
        currentSiteId: valueByHeader(peopleSheet, peopleHeaders, row, "CURRENT SITE ID"),
        lastUpdated: valueByHeader(peopleSheet, peopleHeaders, row, "LAST UPDATED"),
      });
    }

    this.attempts = [];
    this.summaryRows.clear();
    this.summaries.clear();
    for (let row = 2; row <= lastRow(resultsSheet); row += 1) {
      const summaryPersonId = cellValue(resultsSheet, row, 1);
      if (summaryPersonId) {
        this.summaryRows.set(summaryPersonId, row);
        this.summaries.set(summaryPersonId, {
          personId: summaryPersonId,
          name: cellValue(resultsSheet, row, 2),
          attemptedAt: cellValue(resultsSheet, row, 3),
          sitesAttempted: Number.parseInt(cellValue(resultsSheet, row, 4), 10) || 0,
          passed: Number.parseInt(cellValue(resultsSheet, row, 5), 10) || 0,
          failed: Number.parseInt(cellValue(resultsSheet, row, 6), 10) || 0,
          humanReview: Number.parseInt(cellValue(resultsSheet, row, 7), 10) || 0,
        });
      }
      const attemptId = cellValue(resultsSheet, row, 10);
      if (!attemptId) continue;
      this.attempts.push({
        rowNumber: row,
        attemptId,
        personId: cellValue(resultsSheet, row, 11),
        siteId: cellValue(resultsSheet, row, 12),
        attemptedAt: cellValue(resultsSheet, row, 13),
        status: attemptStatus(cellValue(resultsSheet, row, 14)),
        formStep: Number.parseInt(cellValue(resultsSheet, row, 15), 10) || 0,
        lastUrl: cellValue(resultsSheet, row, 16),
        errorType: cellValue(resultsSheet, row, 17) as ErrorCategory | "",
        retryEligible: cellValue(resultsSheet, row, 18).toUpperCase() === "YES" ? "YES" : "NO",
        notes: cellValue(resultsSheet, row, 19),
      });
    }

    this.issues = [];
    for (let row = 2; row <= lastRow(issuesSheet); row += 1) {
      const siteId = cellValue(issuesSheet, row, 1);
      if (!siteId) continue;
      this.issues.push({
        rowNumber: row,
        siteId,
        siteName: cellValue(issuesSheet, row, 2),
        url: cellValue(issuesSheet, row, 3),
        dateChecked: cellValue(issuesSheet, row, 4),
        issueType: cellValue(issuesSheet, row, 5) as SiteIssue["issueType"],
        httpStatus: Number.parseInt(cellValue(issuesSheet, row, 6), 10) || "",
        redirectUrl: cellValue(issuesSheet, row, 7),
        globalStatus: (cellValue(issuesSheet, row, 8) || "TEMP ERROR") as SiteIssue["globalStatus"],
        notes: cellValue(issuesSheet, row, 9),
      });
    }
  }

  async reconcile(registry: FieldRegistry, statePath?: string): Promise<ReconciliationReport> {
    const peopleSheet = this.sheetValues.get(SHEETS.people);
    const sitesSheet = this.sheetValues.get(SHEETS.sites);
    if (!peopleSheet || !sitesSheet) throw new Error("Workbook schema changed while reconciling.");
    const peopleHeaders = headerMap(peopleSheet);
    const siteHeaders = headerMap(sitesSheet);
    const report: ReconciliationReport = {
      peopleAssigned: [],
      sitesAssigned: [],
      peopleDefaultedPending: [],
      sitesDefaultedActive: [],
      duplicateSites: [],
      knownFields: [],
      unknownFields: [],
      restrictedFields: [],
      changedPersonIds: [],
      changedSiteIds: [],
    };
    let workbookChanged = false;

    for (const header of peopleHeaders.keys()) {
      if (PEOPLE_SYSTEM_HEADERS.has(header)) continue;
      if (headerIsRestricted(registry, header)) report.restrictedFields.push(header);
      else if (registryEntryForHeader(registry, header)) report.knownFields.push(header);
      else report.unknownFields.push(header);
    }

    const historicalPersonIds = new Set(this.attempts.map((attempt) => attempt.personId).filter(Boolean));
    for (let row = 2; row <= lastRow(peopleSheet); row += 1) {
      const populated = PEOPLE_PROFILE_HEADERS.some((header) => Boolean(valueByHeader(peopleSheet, peopleHeaders, row, header)));
      if (!populated) continue;
      let id = valueByHeader(peopleSheet, peopleHeaders, row, "ID");
      if (id && !/^P\d{4,}$/i.test(id)) throw new Error(`Invalid Person ID "${id}" in ${SHEETS.people} row ${row}. Expected P followed by at least four digits.`);
      if (!id) {
        id = nextDurableId("P", [...historicalPersonIds, ...this.people.map((person) => person.id), ...report.peopleAssigned]);
        const idColumn = headerColumn(peopleHeaders, "ID");
        this.setCell(SHEETS.people, `${columnLetter(idColumn - 1)}${row}`, id);
        report.peopleAssigned.push(id);
        workbookChanged = true;
      }
      historicalPersonIds.add(id);
      if (!valueByHeader(peopleSheet, peopleHeaders, row, "STATUS")) {
        const statusColumn = headerColumn(peopleHeaders, "STATUS");
        this.setCell(SHEETS.people, `${columnLetter(statusColumn - 1)}${row}`, "PENDING");
        report.peopleDefaultedPending.push(id);
        workbookChanged = true;
      }
    }

    const historicalSiteIds = new Set(this.attempts.map((attempt) => attempt.siteId).filter(Boolean));
    const canonicalUrls = new Map<string, string>();
    for (let row = 2; row <= lastRow(sitesSheet); row += 1) {
      const url = valueByHeader(sitesSheet, siteHeaders, row, "SIGNUP URL");
      if (!url) continue;
      let id = valueByHeader(sitesSheet, siteHeaders, row, "SITE ID");
      if (id && !/^S\d{4,}$/i.test(id)) throw new Error(`Invalid Site ID "${id}" in ${SHEETS.sites} row ${row}. Expected S followed by at least four digits.`);
      if (!id) {
        id = nextDurableId("S", [...historicalSiteIds, ...this.sites.map((site) => site.id), ...report.sitesAssigned]);
        const idColumn = headerColumn(siteHeaders, "SITE ID");
        this.setCell(SHEETS.sites, `${columnLetter(idColumn - 1)}${row}`, id);
        report.sitesAssigned.push(id);
        workbookChanged = true;
      }
      historicalSiteIds.add(id);
      if (!valueByHeader(sitesSheet, siteHeaders, row, "ACTIVE")) {
        const activeColumn = headerColumn(siteHeaders, "ACTIVE");
        this.setCell(SHEETS.sites, `${columnLetter(activeColumn - 1)}${row}`, "YES");
        report.sitesDefaultedActive.push(id);
        workbookChanged = true;
      }
      let normalized = "";
      try {
        normalized = normalizeUrl(url);
      } catch {
        continue;
      }
      const canonicalId = canonicalUrls.get(normalized);
      if (canonicalId) {
        if (valueByHeader(sitesSheet, siteHeaders, row, "ACTIVE").toUpperCase() !== "NO" ||
            valueByHeader(sitesSheet, siteHeaders, row, "SITE STATUS").toUpperCase() !== "DUPLICATE") {
          this.setCell(SHEETS.sites, `${columnLetter(headerColumn(siteHeaders, "ACTIVE") - 1)}${row}`, "NO");
          this.setCell(SHEETS.sites, `${columnLetter(headerColumn(siteHeaders, "SITE STATUS") - 1)}${row}`, "DUPLICATE");
          workbookChanged = true;
        }
        report.duplicateSites.push({ duplicateId: id, canonicalId });
      } else {
        canonicalUrls.set(normalized, id);
      }
    }

    if (workbookChanged) {
      await this.checkpoint();
      this.loadRows();
    }
    for (const [header, column] of peopleHeaders.entries()) {
      if (PEOPLE_SYSTEM_HEADERS.has(header) || headerIsRestricted(registry, header)) continue;
      const registered = registryEntryForHeader(registry, header);
      if (!registered) continue;
      const [canonical, entry] = registered;
      if (["dobMonth", "dobDay", "dobYear"].includes(entry.profileField)) continue;
      for (const person of this.people) {
        const value = cellValue(peopleSheet, person.rowNumber, column);
        if (!value) continue;
        person.dynamicFields[entry.profileField] = value;
        person.dynamicFields[canonical] = value;
        const direct = person[entry.profileField as keyof PersonProfile];
        if (typeof direct === "string" && !direct) {
          (person as unknown as Record<string, unknown>)[entry.profileField] = value;
        }
      }
    }

    if (statePath) {
      let previous: ReconciliationState = { version: 1, people: {}, sites: {} };
      try {
        previous = JSON.parse(await readFile(statePath, "utf8")) as ReconciliationState;
      } catch {
        // First reconciliation on this installation.
      }
      const current: ReconciliationState = { version: 1, people: {}, sites: {} };
      for (const person of this.people) {
        const hash = contentHash([
          person.firstName,
          person.lastName,
          person.phone,
          person.email,
          person.address,
          person.city,
          person.state,
          person.zip,
          person.dob,
          person.occupation,
          person.annualIncome,
          person.password,
        ]);
        current.people[person.id] = hash;
        if (previous.people[person.id] && previous.people[person.id] !== hash) report.changedPersonIds.push(person.id);
      }
      for (const site of this.sites) {
        const hash = contentHash([site.name, site.signupUrl, String(site.active)]);
        current.sites[site.id] = hash;
        if (previous.sites[site.id] && previous.sites[site.id] !== hash) report.changedSiteIds.push(site.id);
      }
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify(current, null, 2), "utf8");
    }
    return report;
  }

  getSites(): readonly Site[] {
    return this.sites.filter((site) => siteRowClass(site) !== "RESERVED");
  }

  getSitesIncludingReserved(): readonly Site[] {
    return this.sites;
  }

  getPeople(): readonly PersonProfile[] {
    return this.people;
  }

  async ingestPerson(input: SignupIntake): Promise<{ person: PersonProfile; created: boolean }> {
    const email = input.email.trim().toLowerCase();
    if (!input.requestId.trim() || !input.firstName.trim() || !input.lastName.trim() || !email) {
      throw new Error("requestId, firstName, lastName, and email are required.");
    }
    const existing = this.people.find((person) => person.email.trim().toLowerCase() === email);
    if (existing) {
      if (
        existing.firstName.trim().toLowerCase() !== input.firstName.trim().toLowerCase() ||
        existing.lastName.trim().toLowerCase() !== input.lastName.trim().toLowerCase()
      ) {
        throw new Error(`Email already belongs to a different workbook profile (${existing.id}).`);
      }
      return { person: existing, created: false };
    }

    const sheet = this.sheetValues.get(SHEETS.people);
    if (!sheet) throw new Error("People worksheet is not loaded.");
    const headers = headerMap(sheet);
    const rowNumber = Math.max(2, lastRow(sheet) + 1);
    const id = nextDurableId("P", [
      ...this.people.map((person) => person.id),
      ...this.attempts.map((attempt) => attempt.personId),
    ]);
    const now = new Date().toISOString();
    const values: Record<string, string> = {
      ID: id,
      "FIRST NAME/GIVEN NAME": input.firstName.trim(),
      "LAST NAME": input.lastName.trim(),
      PHONE: input.phone?.trim() ?? "",
      EMAIL: email,
      ADDRESS: input.address?.trim() ?? "",
      CITY: input.city?.trim() ?? "",
      STATE: input.state?.trim() ?? "",
      ZIP: input.zip?.trim() ?? "",
      DOB: input.dob?.trim() ?? "",
      OCCUPATION: input.occupation?.trim() ?? "",
      "ANNUAL INCOME": input.annualIncome?.trim() ?? "",
      PASSWORD: input.password ?? "",
      STATUS: "PENDING",
      "CURRENT SITE ID": "",
      "LAST UPDATED": now,
    };
    for (const [header, value] of Object.entries(values)) {
      const column = headerColumn(headers, header);
      if (column) this.setCell(SHEETS.people, `${columnLetter(column - 1)}${rowNumber}`, value);
    }
    const person: PersonProfile = {
      rowNumber,
      id,
      firstName: values["FIRST NAME/GIVEN NAME"] ?? "",
      lastName: values["LAST NAME"] ?? "",
      phone: values.PHONE ?? "",
      email,
      address: values.ADDRESS ?? "",
      city: values.CITY ?? "",
      state: values.STATE ?? "",
      zip: values.ZIP ?? "",
      dob: values.DOB ?? "",
      occupation: values.OCCUPATION ?? "",
      annualIncome: values["ANNUAL INCOME"] ?? "",
      password: values.PASSWORD ?? "",
      dynamicFields: {},
      status: "PENDING",
      currentSiteId: "",
      lastUpdated: now,
    };
    this.people.push(person);
    await this.checkpoint();
    return { person, created: true };
  }

  getAttempts(): readonly AttemptRecord[] {
    return this.attempts;
  }

  getSiteIssues(): readonly SiteIssue[] {
    return this.issues;
  }

  getPersonSummary(personId: string): PersonSummary | undefined {
    return this.summaries.get(personId);
  }

  getPersonProgress(person: PersonProfile, eligibleSites: readonly Site[]): PersonProgress {
    const latest = new Map<string, AttemptRecord>();
    for (const attempt of this.attempts.filter((item) => item.personId === person.id)) latest.set(attempt.siteId, attempt);
    const eligibleIds = new Set(eligibleSites.map((site) => site.id));
    const completed = [...latest.values()].filter((attempt) => eligibleIds.has(attempt.siteId) && attempt.status === "COMPLETED").length;
    const humanReview = [...latest.values()].filter(
      (attempt) => eligibleIds.has(attempt.siteId) && attempt.status === "WAITING FOR HUMAN",
    ).length;
    return {
      personId: person.id,
      name: `${person.firstName} ${person.lastName}`.trim() || person.id,
      status: person.status || "PENDING",
      completed,
      remaining: Math.max(0, eligibleSites.length - completed),
      humanReview,
    };
  }

  getLatestAttempt(personId: string, siteId: string): AttemptRecord | undefined {
    return this.attempts.filter((attempt) => attempt.personId === personId && attempt.siteId === siteId).at(-1);
  }

  getAttemptCount(personId: string, siteId: string): number {
    return this.attempts.filter((attempt) => attempt.personId === personId && attempt.siteId === siteId).length;
  }

  isSiteGloballyExcluded(siteId: string): boolean {
    return this.issues.some((issue) => issue.siteId === siteId && issue.globalStatus === "INVALID");
  }

  private setCell(sheetName: string, address: string, value: CellValue): void {
    const xml = this.sheetXml.get(sheetName);
    if (!xml) throw new Error(`Worksheet XML is not loaded: ${sheetName}`);
    this.sheetXml.set(sheetName, setCellInWorksheetXml(xml, address, value));
    this.sheetValues.get(sheetName)?.set(address, String(value));
  }

  private async checkpoint(): Promise<void> {
    const operation = this.checkpointQueue.then(() => this.writeCheckpoint());
    this.checkpointQueue = operation.catch(() => undefined);
    await operation;
  }

  private async writeCheckpoint(): Promise<void> {
    for (const [sheetName, xml] of this.sheetXml.entries()) {
      const sheetPath = this.sheetPaths.get(sheetName);
      if (!sheetPath) throw new Error(`Worksheet path is not loaded: ${sheetName}`);
      this.zip.file(sheetPath, xml);
    }
    const buffer = await this.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const tempPath = `${this.workbookPath}.${process.pid}.${Date.now()}.tmp.xlsx`;
    await writeFile(tempPath, buffer, { flag: "wx" });
    try {
      await copyFile(this.workbookPath, this.backupPath);
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await rename(tempPath, this.workbookPath);
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      throw lastError;
    } catch (error) {
      await rm(tempPath, { force: true });
      throw new Error(
        `Could not checkpoint workbook. Close it in Excel and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async beginOrResumeAttempt(person: PersonProfile, site: Site, prior?: AttemptRecord): Promise<AttemptRecord> {
    const now = new Date().toISOString();
    if (prior && (prior.status === "IN PROGRESS" || prior.status === "WAITING FOR HUMAN")) {
      prior.status = "IN PROGRESS";
      prior.retryEligible = "YES";
      prior.notes = appendNote(prior.notes, `Resumed ${now}`);
      this.writeAttempt(prior);
      await this.checkpoint();
      return prior;
    }

    const rowNumber = Math.max(2, ...this.attempts.map((attempt) => attempt.rowNumber + 1));
    const attempt: AttemptRecord = {
      rowNumber,
      attemptId: makeAttemptId(),
      personId: person.id,
      siteId: site.id,
      attemptedAt: now,
      status: "IN PROGRESS",
      formStep: 0,
      lastUrl: safeUrl(site.finalUrl || site.signupUrl),
      errorType: "",
      retryEligible: "YES",
      notes: "Attempt started",
    };
    this.attempts.push(attempt);
    this.writeAttempt(attempt);
    await this.checkpoint();
    return attempt;
  }

  private writeAttempt(attempt: AttemptRecord): void {
    const row = attempt.rowNumber;
    const values: CellValue[] = [
      attempt.attemptId,
      attempt.personId,
      attempt.siteId,
      attempt.attemptedAt,
      attempt.status,
      attempt.formStep,
      safeUrl(attempt.lastUrl),
      attempt.errorType,
      attempt.retryEligible,
      attempt.notes,
    ];
    values.forEach((value, index) => this.setCell(SHEETS.results, `${columnLetter(9 + index)}${row}`, value));
  }

  async updateAttempt(attempt: AttemptRecord, update: AttemptUpdate): Promise<void> {
    Object.assign(attempt, update);
    this.writeAttempt(attempt);
    await this.checkpoint();
  }

  async updatePerson(person: PersonProfile, status: string, currentSiteId = ""): Promise<void> {
    person.status = status;
    person.currentSiteId = currentSiteId;
    person.lastUpdated = new Date().toISOString();
    const sheet = this.sheetValues.get(SHEETS.people);
    if (!sheet) throw new Error("People worksheet is not loaded.");
    const headers = headerMap(sheet);
    this.setCell(SHEETS.people, `${columnLetter(headerColumn(headers, "STATUS") - 1)}${person.rowNumber}`, status);
    this.setCell(SHEETS.people, `${columnLetter(headerColumn(headers, "CURRENT SITE ID") - 1)}${person.rowNumber}`, currentSiteId);
    this.setCell(SHEETS.people, `${columnLetter(headerColumn(headers, "LAST UPDATED") - 1)}${person.rowNumber}`, person.lastUpdated);
    await this.checkpoint();
  }

  async updatePersonSummary(person: PersonProfile): Promise<void> {
    let summaryRow = this.summaryRows.get(person.id);
    if (!summaryRow) {
      summaryRow = Math.max(2, ...[...this.summaryRows.values()].map((row) => row + 1));
      this.summaryRows.set(person.id, summaryRow);
    }

    const latest = new Map<string, AttemptRecord>();
    for (const attempt of this.attempts.filter((item) => item.personId === person.id)) latest.set(attempt.siteId, attempt);
    const attempts = [...latest.values()];
    const attempted = attempts.filter((attempt) => attempt.status !== "SITE INVALID").length;
    const passed = attempts.filter((attempt) => attempt.status === "COMPLETED").length;
    const failed = attempts.filter((attempt) => attempt.status === "FAILED").length;
    const humanReview = attempts.filter((attempt) => attempt.status === "WAITING FOR HUMAN").length;
    const lastAttempted = attempts.map((attempt) => attempt.attemptedAt).sort().at(-1) ?? "";
    const values: CellValue[] = [
      person.id,
      `${person.firstName} ${person.lastName}`.trim(),
      lastAttempted,
      attempted,
      passed,
      failed,
      humanReview,
    ];
    values.forEach((value, index) => this.setCell(SHEETS.results, `${columnLetter(index)}${summaryRow}`, value));
    this.summaries.set(person.id, {
      personId: person.id,
      name: `${person.firstName} ${person.lastName}`.trim(),
      attemptedAt: lastAttempted,
      sitesAttempted: attempted,
      passed,
      failed,
      humanReview,
    });
    await this.checkpoint();
  }

  async updateSite(site: Site, status: string, finalUrl: string, note: string): Promise<void> {
    const now = new Date().toISOString();
    site.status = status;
    site.lastChecked = now;
    site.finalUrl = safeUrl(finalUrl);
    site.notes = appendNote(site.notes, note);
    const sheet = this.sheetValues.get(SHEETS.sites);
    if (!sheet) throw new Error("Sites worksheet is not loaded.");
    const headers = headerMap(sheet);
    this.setCell(SHEETS.sites, `${columnLetter(headerColumn(headers, "SITE STATUS") - 1)}${site.rowNumber}`, site.status);
    this.setCell(SHEETS.sites, `${columnLetter(headerColumn(headers, "LAST CHECKED") - 1)}${site.rowNumber}`, site.lastChecked);
    this.setCell(SHEETS.sites, `${columnLetter(headerColumn(headers, "FINAL URL") - 1)}${site.rowNumber}`, site.finalUrl);
    this.setCell(SHEETS.sites, `${columnLetter(headerColumn(headers, "NOTES") - 1)}${site.rowNumber}`, site.notes);
    await this.checkpoint();
  }

  async recordSiteIssue(issue: SiteIssue): Promise<void> {
    const existing = this.issues.find(
      (row) => row.siteId === issue.siteId && row.issueType === issue.issueType && safeUrl(row.url) === safeUrl(issue.url),
    );
    const rowNumber = existing?.rowNumber ?? Math.max(2, ...this.issues.map((row) => row.rowNumber + 1));
    const row: IssueRow = { ...issue, rowNumber };
    if (existing) Object.assign(existing, row);
    else this.issues.push(row);
    const values: CellValue[] = [
      row.siteId,
      row.siteName,
      safeUrl(row.url),
      row.dateChecked,
      row.issueType,
      row.httpStatus,
      safeUrl(row.redirectUrl),
      row.globalStatus,
      row.notes,
    ];
    values.forEach((value, index) => this.setCell(SHEETS.issues, `${columnLetter(index)}${rowNumber}`, value));
    await this.checkpoint();
  }

  async release(): Promise<void> {
    await this.checkpointQueue;
    if (!this.lockHandle) return;
    await this.lockHandle.close();
    this.lockHandle = undefined;
    await rm(this.lockPath, { force: true });
  }
}
