import { writeFile } from "node:fs/promises";
import JSZip from "jszip";

export const SITE_HEADERS = ["SITE ID", "SITE NAME", "SIGNUP URL", "ACTIVE", "SITE STATUS", "LAST CHECKED", "FINAL URL", "NOTES"];
export const PEOPLE_HEADERS = [
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
export const RESULT_HEADERS = [
  "ID",
  "NAME",
  "DATE ATTEMPTED",
  "SITES ATTEMPTED",
  "PASSED",
  "FAILED",
  "HUMAN REVIEW",
  "",
  "",
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
];
export const ISSUE_HEADERS = [
  "SITE ID",
  "SITE NAME",
  "URL",
  "DATE CHECKED",
  "ISSUE TYPE",
  "HTTP STATUS",
  "REDIRECT URL",
  "GLOBAL STATUS",
  "NOTES",
];

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function columnLetter(zeroBased: number): string {
  let value = zeroBased + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function worksheetXml(rows: string[][]): string {
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) =>
          value === ""
            ? ""
            : `<x:c r="${columnLetter(columnIndex)}${rowIndex + 1}" t="str"><x:v>${xmlEscape(value)}</x:v></x:c>`,
        )
        .join("");
      return `<x:row r="${rowIndex + 1}">${cells}</x:row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>${rowXml}</x:sheetData></x:worksheet>`;
}

export interface WorkbookFixture {
  sites?: string[][];
  people?: string[][];
  results?: string[][];
  issues?: string[][];
  peopleHeaders?: string[];
}

export async function createFixtureWorkbook(target: string, fixture: WorkbookFixture = {}): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet 1 Sites" sheetId="1" r:id="rId1"/><sheet name="Sheet 2 People" sheetId="2" r:id="rId2"/><sheet name="Sheet 3 Results" sheetId="3" r:id="rId3"/><sheet name="Sheet 4 Site Issues" sheetId="4" r:id="rId4"/></sheets></workbook>',
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/></Relationships>',
  );
  zip.file("xl/worksheets/sheet1.xml", worksheetXml([SITE_HEADERS, ...(fixture.sites ?? [])]));
  zip.file("xl/worksheets/sheet2.xml", worksheetXml([fixture.peopleHeaders ?? PEOPLE_HEADERS, ...(fixture.people ?? [])]));
  zip.file("xl/worksheets/sheet3.xml", worksheetXml([RESULT_HEADERS, ...(fixture.results ?? [])]));
  zip.file("xl/worksheets/sheet4.xml", worksheetXml([ISSUE_HEADERS, ...(fixture.issues ?? [])]));
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
