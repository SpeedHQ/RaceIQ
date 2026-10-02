import type { SEEDED_GAME_CASES } from "../../support/seeded/cases";

type GameId = (typeof SEEDED_GAME_CASES)[number]["gameId"];

export const RECORDING_BY_GAME = {
  "fm-2023": "fm-2023-2026-04-09T21-55-03-186Z",
  "f1-2025": "f1-2025-2026-04-22T11-42-43-029Z",
  acc: "acc-2026-04-23T16-42-16-158Z",
  "ac-evo": "session-ac-evo-mid-2026-04-21T20-24-34-810Z",
  iracing: "iracing-daytona-am-vantage-gt3-pit",
} as const satisfies Record<GameId, string>;

export type LiveChannel =
  | { kind: "dynamic"; label: string }
  | { kind: "static"; label: string }
  | { kind: "event"; label: string; states: readonly string[] };

/**
 * Browser-visible channel contract. Dynamic values must move; event channels
 * must expose at least two fixture states; static values only prove presence.
 */
export const LIVE_CHANNELS_BY_GAME = {
  "fm-2023": [
    { kind: "dynamic", label: "Current" },
    { kind: "static", label: "Lap" },
  ],
  "f1-2025": [
    { kind: "dynamic", label: "Current" },
    { kind: "dynamic", label: "ERS" },
    { kind: "static", label: "Weather" },
    { kind: "static", label: "DRS" },
  ],
  acc: [
    { kind: "dynamic", label: "Current" },
    { kind: "static", label: "Lap" },
    { kind: "static", label: "Fuel" },
  ],
  "ac-evo": [
    { kind: "dynamic", label: "Current" },
    { kind: "static", label: "Lap" },
  ],
  iracing: [
    { kind: "dynamic", label: "Current" },
    { kind: "static", label: "Lap" },
  ],
} as const satisfies Record<GameId, readonly LiveChannel[]>;
