import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "../catalog/csv";
import { SHARED_DIR } from "../runtime/data-paths";

const teams = new Map<number, string>();
const raw = readFileSync(resolve(SHARED_DIR, "games/f1-2025/teams.csv"), "utf-8");
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

const COMPOUND_BY_ID: Record<number, string> = {
  16: "soft",
  17: "medium",
  18: "hard",
  7: "inter",
  8: "wet",
};

export function getF1CompoundName(visualCompound: number): string {
  return COMPOUND_BY_ID[visualCompound] ?? "unknown";
}
