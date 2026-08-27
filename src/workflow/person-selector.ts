import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { WorkbookStore } from "../excel/workbook-store.js";
import type { PersonProfile, PersonProgress, Site } from "../types/models.js";

export type PersonSelection = { mode: "person"; personIds: string[] } | { mode: "all"; personIds: string[] } | { mode: "quit"; personIds: [] };

export function commandLineSelection(argv: string[]): { personId?: string; all: boolean } {
  const index = argv.indexOf("--person");
  const personId = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (index >= 0 && !personId) throw new Error("--person requires a Person ID, for example --person P0003.");
  const all = argv.includes("--all");
  if (personId && all) throw new Error("Choose either --person or --all, not both.");
  return { ...(personId ? { personId } : {}), all };
}

export function formatPersonMenu(progress: readonly PersonProgress[], version: string): string {
  const lines = [
    `MAG Automation v${version}`,
    "",
    "Select a person to process:",
    "",
    ...progress.map((person, index) => {
      const review = person.humanReview ? ` | ${person.humanReview} human review` : "";
      return `[${index + 1}] ${person.personId} | ${person.name} | ${person.status} | ${person.completed} completed | ${person.remaining} remaining${review}`;
    }),
    `[${progress.length + 1}] Process all eligible people`,
    "[Q] Quit",
    "",
  ];
  return lines.join("\n");
}

function directPerson(people: readonly PersonProfile[], personId: string): PersonSelection {
  const normalized = personId.toUpperCase();
  const person = people.find((candidate) => candidate.id.toUpperCase() === normalized);
  if (!person) {
    throw new Error(`Person ID not found: ${personId}. Available IDs: ${people.map((candidate) => candidate.id).join(", ") || "none"}.`);
  }
  return { mode: "person", personIds: [person.id] };
}

export async function selectPeople(
  workbook: WorkbookStore,
  eligibleSites: readonly Site[],
  version: string,
  argv: string[] = process.argv.slice(2),
  input: Readable = defaultInput,
  output: Writable = defaultOutput,
): Promise<PersonSelection> {
  const people = workbook.getPeople();
  if (people.length === 0) throw new Error("No populated people are available in Sheet 2 People.");
  const direct = commandLineSelection(argv);
  if (direct.personId) return directPerson(people, direct.personId);
  if (direct.all) return { mode: "all", personIds: people.map((person) => person.id) };
  if (input === defaultInput && !process.stdin.isTTY) {
    throw new Error(`Interactive person selection requires a terminal. Use --person <ID> or --all. Available IDs: ${people.map((person) => person.id).join(", ")}.`);
  }
  const progress = people.map((person) => workbook.getPersonProgress(person, eligibleSites));
  output.write(`${formatPersonMenu(progress, version)}Selection: `);
  const readline = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await readline.question("")).trim();
      if (/^(q|quit)$/i.test(answer)) return { mode: "quit", personIds: [] };
      const numeric = Number.parseInt(answer, 10);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= people.length) {
        const selected = people[numeric - 1];
        if (selected) return { mode: "person", personIds: [selected.id] };
      }
      if (numeric === people.length + 1) return { mode: "all", personIds: people.map((person) => person.id) };
      const byId = people.find((person) => person.id.toUpperCase() === answer.toUpperCase());
      if (byId) return { mode: "person", personIds: [byId.id] };
      output.write(`Choose 1-${people.length + 1}, enter a listed Person ID, or Q: `);
    }
  } finally {
    readline.close();
  }
}
