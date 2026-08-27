import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parseWorksheetXml } from "../excel/workbook-store.js";

const EXPECTED_SHEETS = ["Sheet 1 Sites", "Sheet 2 People", "Sheet 3 Results", "Sheet 4 Site Issues"];
const EXPECTED_PEOPLE_HEADERS = [
  "ID",
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
  "STATUS",
  "CURRENT SITE ID",
  "LAST UPDATED",
];

function decodeXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((match) =>
    [...(match[1] ?? "").matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
      .map((text) => decodeXml(text[1] ?? ""))
      .join(""),
  );
}

export async function validateCleanTemplate(templatePath: string): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(templatePath));
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relationshipsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relationshipsXml) throw new Error("Template workbook relationships are missing.");
  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)) {
    const attributes = match[1] ?? "";
    const id = /\bId="([^"]+)"/.exec(attributes)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attributes)?.[1];
    if (id && target) {
      relationships.set(id, target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`);
    }
  }
  const sheets = [...workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/?>(?:<\/(?:\w+:)?sheet>)?/g)].map(
    (match) => ({ name: match[1] ?? "", relationshipId: match[2] ?? "" }),
  );
  assertExact(sheets.map((sheet) => sheet.name), EXPECTED_SHEETS, "worksheet names");
  const people = sheets.find((sheet) => sheet.name === "Sheet 2 People");
  const peoplePath = people ? relationships.get(people.relationshipId) : undefined;
  const peopleXml = peoplePath ? await zip.file(peoplePath)?.async("string") : undefined;
  if (!peopleXml) throw new Error("People worksheet XML is missing.");
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const values = parseWorksheetXml(peopleXml, sharedXml ? sharedStrings(sharedXml) : []);
  const headers: string[] = [];
  for (let index = 0; index < EXPECTED_PEOPLE_HEADERS.length + 4; index += 1) {
    const letter = String.fromCharCode(65 + index);
    const value = values.get(`${letter}1`)?.trim() ?? "";
    if (value) headers.push(value);
  }
  assertExact(headers, EXPECTED_PEOPLE_HEADERS, "People headers");
}

function assertExact(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Clean template ${label} must be exactly: ${expected.join(", ")}. Found: ${actual.join(", ")}.`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const template = path.resolve("templates", "MAG_Signup_Automation_Clean_Template.xlsx");
  try {
    await validateCleanTemplate(template);
    console.log(`PASS: clean workbook template validated at ${template}`);
  } catch (error) {
    console.error(`FAIL: clean workbook template validation: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
