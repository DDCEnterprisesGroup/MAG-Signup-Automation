export interface TargetedRunArgs { personId: string; siteId: string; rest: string[]; }

export function parseTargetedRunArgs(args: readonly string[]): TargetedRunArgs {
  if (args.includes("--all")) throw new Error("Targeted runs cannot use --all.");
  const personIndex = args.indexOf("--person");
  const siteIndex = args.indexOf("--site");
  const personId = personIndex >= 0 ? args[personIndex + 1]?.trim().toUpperCase() : "";
  const siteId = siteIndex >= 0 ? args[siteIndex + 1]?.trim().toUpperCase() : "";
  if (!personId || !siteId || !/^P\d{4,}$/.test(personId) || !/^S\d{4,}$/.test(siteId)) {
    throw new Error("Usage: mag run --person P0001 --site S0001");
  }
  const consumed = new Set<number>();
  if (personIndex >= 0) { consumed.add(personIndex); consumed.add(personIndex + 1); }
  if (siteIndex >= 0) { consumed.add(siteIndex); consumed.add(siteIndex + 1); }
  const rest = args.filter((arg, index) => !consumed.has(index) && arg !== "--dry-run");
  if (rest.length) throw new Error(`Unsupported targeted-run option: ${rest[0]}`);
  return { personId, siteId, rest: args.includes("--dry-run") ? ["--dry-run"] : [] };
}

export function parseHandoffArgs(args: readonly string[]): { action: "resume" | "skip" | "confirm"; personId: string; siteId: string } {
  const [action, person, site, ...extra] = args;
  if (!["resume", "skip", "confirm"].includes(action ?? "") || !person || !site || extra.length ||
      !/^P\d{4,}$/i.test(person) || !/^S\d{4,}$/i.test(site)) {
    throw new Error("Usage: mag handoff <resume|skip|confirm> <personId> <siteId>");
  }
  return { action: action as "resume" | "skip" | "confirm", personId: person.toUpperCase(), siteId: site.toUpperCase() };
}
