export interface LmuRestChannelDefinition {
  readonly endpoint: string;
  readonly applicability: "player-vehicle" | "session";
  readonly unit: string | null;
  readonly staleAfterMs: number;
  readonly kind: "number" | "boolean" | "forecast" | "snapshot" | "condition" | "unverified";
}

/** Read-only LMU REST inventory. These schemas have reference, not Windows runtime, evidence. */
export const LMU_REST_CHANNELS = {
  "lmu.rest.session.time-scale": { endpoint: "/rest/sessions", applicability: "session", unit: "ratio", staleAfterMs: 120_000, kind: "number" },
  "lmu.rest.session.private-qualifying": { endpoint: "/rest/sessions", applicability: "session", unit: null, staleAfterMs: 120_000, kind: "boolean" },
  "lmu.rest.forecast.practice": { endpoint: "/rest/sessions/weather", applicability: "session", unit: null, staleAfterMs: 120_000, kind: "forecast" },
  "lmu.rest.forecast.qualify": { endpoint: "/rest/sessions/weather", applicability: "session", unit: null, staleAfterMs: 120_000, kind: "forecast" },
  "lmu.rest.forecast.race": { endpoint: "/rest/sessions/weather", applicability: "session", unit: null, staleAfterMs: 120_000, kind: "forecast" },
  "lmu.rest.garage.steering-lock": { endpoint: "/rest/garage/getPlayerGarageData", applicability: "player-vehicle", unit: "°", staleAfterMs: 120_000, kind: "number" },
  "lmu.rest.garage.setup": { endpoint: "/rest/garage/getPlayerGarageData", applicability: "player-vehicle", unit: null, staleAfterMs: 120_000, kind: "snapshot" },
  "lmu.rest.condition.aero": { endpoint: "/rest/garage/UIScreen/RepairAndRefuel", applicability: "player-vehicle", unit: null, staleAfterMs: 3_000, kind: "condition" },
  "lmu.rest.condition.brakes": { endpoint: "/rest/garage/UIScreen/RepairAndRefuel", applicability: "player-vehicle", unit: null, staleAfterMs: 3_000, kind: "condition" },
  "lmu.rest.condition.suspension": { endpoint: "/rest/garage/UIScreen/RepairAndRefuel", applicability: "player-vehicle", unit: null, staleAfterMs: 3_000, kind: "condition" },
  "lmu.rest.energy.capacity": { endpoint: "/rest/garage/UIScreen/RepairAndRefuel", applicability: "player-vehicle", unit: null, staleAfterMs: 3_000, kind: "unverified" },
  "lmu.rest.refill.selection": { endpoint: "/rest/garage/UIScreen/RepairAndRefuel", applicability: "player-vehicle", unit: null, staleAfterMs: 3_000, kind: "unverified" },
  "lmu.rest.pitstop.estimate": { endpoint: "/rest/strategy/pitstop-estimate", applicability: "player-vehicle", unit: null, staleAfterMs: 3_000, kind: "unverified" },
  "lmu.rest.repair.estimate": { endpoint: "/rest/strategy/pitstop-estimate", applicability: "player-vehicle", unit: null, staleAfterMs: 3_000, kind: "unverified" },
} as const satisfies Readonly<Record<string, LmuRestChannelDefinition>>;
export type LmuRestSemanticId = keyof typeof LMU_REST_CHANNELS;
export const LMU_FORECAST_NODES = ["START", "NODE_25", "NODE_50", "NODE_75", "FINISH"] as const;
export interface LmuForecastNode { readonly sky: number; readonly temperatureC: number; readonly rainChance: number; }
export type LmuForecast = Readonly<Record<typeof LMU_FORECAST_NODES[number], LmuForecastNode>>;

export function isLmuJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 4096 && value.every((item) => isLmuJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 4096 && entries.every(([key, item]) => key !== "__proto__" && key !== "constructor" && isLmuJsonValue(item, depth + 1));
}

export function isLmuRestValue(semanticId: string, value: unknown): boolean {
  if (!Object.hasOwn(LMU_REST_CHANNELS, semanticId)) return false;
  const spec = LMU_REST_CHANNELS[semanticId as LmuRestSemanticId];
  if (value === null) return true;
  if (spec.kind === "unverified") return false;
  if (spec.kind === "number") return typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (spec.kind === "boolean") return typeof value === "boolean";
  if (spec.kind === "snapshot") return typeof value === "object" && !Array.isArray(value) && isLmuJsonValue(value);
  if (spec.kind === "condition") return (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (Array.isArray(value) && value.length === 4 && value.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0));
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const nodes = value as Record<string, unknown>;
  return Object.keys(nodes).length === LMU_FORECAST_NODES.length && LMU_FORECAST_NODES.every((key) => {
    const node = nodes[key];
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const n = node as Record<string, unknown>;
    return Object.keys(n).length === 3 && typeof n.sky === "number" && Number.isInteger(n.sky) && n.sky >= 0 &&
      typeof n.temperatureC === "number" && Number.isFinite(n.temperatureC) &&
      typeof n.rainChance === "number" && Number.isFinite(n.rainChance) && n.rainChance >= 0 && n.rainChance <= 1;
  });
}
