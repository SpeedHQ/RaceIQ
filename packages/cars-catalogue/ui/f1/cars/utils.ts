import type { F1Team } from "./types";

export function teamBrand(team: F1Team): string {
  return team.name.toLowerCase().replaceAll(" ", "-");
}

export function getRatingColor(value: number): string {
  if (value >= 93) return "text-(--severity-nominal)";
  if (value >= 88) return "text-status-info";
  if (value >= 83) return "text-(--severity-caution)";
  return "text-(--severity-warning)";
}
