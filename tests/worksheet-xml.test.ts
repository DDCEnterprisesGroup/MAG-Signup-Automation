import assert from "node:assert/strict";
import test from "node:test";
import { setCellInWorksheetXml } from "../src/excel/workbook-store.js";

test("updates an existing prefixed worksheet cell without disturbing adjacent XML", () => {
  const source =
    '<?xml version="1.0"?><x:worksheet xmlns:x="urn:test"><x:sheetData><x:row r="2"><x:c r="A2" t="str"><x:v>old</x:v></x:c><x:c r="C2"><x:v>3</x:v></x:c></x:row></x:sheetData><x:pageMargins/></x:worksheet>';
  const updated = setCellInWorksheetXml(source, "A2", "new & safe");
  assert.match(updated, /<x:c r="A2" t="str"><x:v>new &amp; safe<\/x:v><\/x:c>/);
  assert.match(updated, /<x:c r="C2"><x:v>3<\/x:v><\/x:c>/);
});

test("updates a self-closing cell without consuming the following cell", () => {
  const source =
    '<x:worksheet xmlns:x="urn:test"><x:sheetData><x:row r="2"><x:c r="A2" s="2" /><x:c r="B2" t="str"><x:v>keep</x:v></x:c></x:row></x:sheetData></x:worksheet>';
  const updated = setCellInWorksheetXml(source, "A2", "filled");
  assert.match(updated, /<x:c r="A2" t="str"><x:v>filled<\/x:v><\/x:c>/);
  assert.match(updated, /<x:c r="B2" t="str"><x:v>keep<\/x:v><\/x:c>/);
});

test("adds ordered cells and new rows", () => {
  const source = '<worksheet><sheetData><row r="2"><c r="A2"><v>1</v></c><c r="C2"><v>3</v></c></row></sheetData></worksheet>';
  const withMiddle = setCellInWorksheetXml(source, "B2", 2);
  assert.ok(withMiddle.indexOf('r="A2"') < withMiddle.indexOf('r="B2"'));
  assert.ok(withMiddle.indexOf('r="B2"') < withMiddle.indexOf('r="C2"'));
  const withRow = setCellInWorksheetXml(withMiddle, "A3", "row three");
  assert.match(withRow, /<row r="3"><c r="A3" t="str"><v>row three<\/v><\/c><\/row>/);
});

test("inserts a missing row in numeric order", () => {
  const source = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="5"><c r="A5"><v>5</v></c></row></sheetData></worksheet>';
  const updated = setCellInWorksheetXml(source, "A3", "three");
  assert.ok(updated.indexOf('row r="1"') < updated.indexOf('row r="3"'));
  assert.ok(updated.indexOf('row r="3"') < updated.indexOf('row r="5"'));
});
