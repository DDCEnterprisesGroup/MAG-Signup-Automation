import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbookStore } from "../src/excel/workbook-store.js";
import type { PersonProfile } from "../src/types/models.js";
import { commandLineSelection, formatPersonMenu, selectPeople } from "../src/workflow/person-selector.js";

test("person selector parses explicit modes and rejects conflicting input", () => {
  assert.deepEqual(commandLineSelection(["--person", "P0003"]), { personId: "P0003", all: false });
  assert.deepEqual(commandLineSelection(["--all"]), { all: true });
  assert.throws(() => commandLineSelection(["--person"]), /requires a Person ID/);
  assert.throws(() => commandLineSelection(["--person", "P0001", "--all"]), /either --person or --all/);
});

test("direct selector never falls back when the Person ID is unknown", async () => {
  const person: PersonProfile = {
    rowNumber: 2,
    id: "P0001",
    firstName: "Taylor",
    lastName: "Example",
    phone: "",
    email: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    dob: "",
    occupation: "",
    annualIncome: "",
    password: "",
    dynamicFields: {},
    status: "PENDING",
    currentSiteId: "",
    lastUpdated: "",
  };
  const workbook = { getPeople: () => [person] } as unknown as WorkbookStore;
  await assert.rejects(selectPeople(workbook, [], "1.1.0", ["--person", "P9999"]), /Available IDs: P0001/);
  assert.deepEqual(await selectPeople(workbook, [], "1.1.0", ["--person", "P0001"]), { mode: "person", personIds: ["P0001"] });
  assert.deepEqual(await selectPeople(workbook, [], "1.1.0", ["--all"]), { mode: "all", personIds: ["P0001"] });
});

test("person menu displays durable IDs, names, ledger progress, and explicit all mode", () => {
  const menu = formatPersonMenu(
    [
      { personId: "P0001", name: "Taylor Example", status: "PENDING", completed: 725, remaining: 76, humanReview: 2 },
      { personId: "P0002", name: "Jane Doe", status: "PENDING", completed: 0, remaining: 801, humanReview: 0 },
    ],
    "1.1.0",
  );
  assert.match(menu, /MAG Automation v1\.1\.0/);
  assert.match(menu, /P0001 \| Taylor Example \| PENDING \| 725 completed \| 76 remaining \| 2 human review/);
  assert.match(menu, /Process all eligible people/);
});
