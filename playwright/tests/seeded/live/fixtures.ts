import { SEEDED_GAME_CASES } from "../../support/seeded/cases";

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
  | { kind: "event"; label: string; states: readonly string[] }
  | {
      kind: "fixture-limited-value";
      label: string;
      expected: string;
      evidence: string;
    };

/**
 * Browser-visible channel contract. Dynamic values must move; event channels
 * must expose at least two fixture states; static values only prove presence.
 * Fixture-limited channels retain exact parser evidence instead of inventing a
 * transition absent from committed native capture.
 */
export const LIVE_CHANNELS_BY_GAME = {
  "fm-2023": [
    { kind: "dynamic", label: "Current" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence: "committed FM replay has no seeded sector best, so server cannot calculate an estimated lap",
    },
    { kind: "static", label: "Lap" },
  ],
  "f1-2025": [
    { kind: "dynamic", label: "Current" },
    { kind: "dynamic", label: "ERS" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence: "committed F1 replay has no EstimatedLapTime values or seeded sector best, so server cannot calculate an estimated lap",
    },
    { kind: "static", label: "Weather" },
    { kind: "event", label: "DRS state", states: ["DRS", "DRS READY", "DRS OPEN"] },
  ],
  acc: [
    { kind: "dynamic", label: "Current" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence: "committed ACC replay resolves track 2 with no seeded sector best, so estimated lap remains unavailable",
    },
    { kind: "static", label: "Lap" },
    { kind: "event", label: "Pit state", states: ["OUT", "PIT LANE", "IN PIT"] },
  ],
  "ac-evo": [
    { kind: "dynamic", label: "Current" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence: "committed AC Evo replay resolves Brands Hatch GP with no seeded sector best, so estimated lap remains unavailable",
    },
    { kind: "static", label: "Lap" },
    { kind: "event", label: "Pit state", states: ["OUT", "PIT LANE", "IN PIT"] },
  ],
  iracing: [
    { kind: "dynamic", label: "Current" },
    { kind: "dynamic", label: "Est. Lap" },
    { kind: "static", label: "Lap" },
    { kind: "event", label: "iRacing pit state", states: ["OUT", "PIT LANE", "IN PIT"] },
  ],
} as const satisfies Record<GameId, readonly LiveChannel[]>;
