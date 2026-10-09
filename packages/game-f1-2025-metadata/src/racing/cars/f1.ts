import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "@raceiq/shared/core/csv";
import { gameCatalogDir } from "@raceiq/shared/platform/runtime/data-paths";

export { getF1CompoundName } from "../compounds";

const teams = new Map<number, string>();
const raw = readFileSync(resolve(gameCatalogDir("f1-2025"), "teams.csv"), "utf-8");
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const fields = parseCsvLine(line);
  const id = Number.parseInt(fields[0], 10);
  if (Number.isInteger(id) && fields[1]) teams.set(id, fields.slice(1).join(","));
}

export function getF1TeamName(teamId: number): string {
  return teams.get(teamId) ?? `Team ${teamId}`;
}

export function getF1CarName(ordinal: number): string {
  return getF1TeamName(ordinal);
}
