import type { GameId } from "../../games/ids";

export const TELEMETRY_RESOLVER_VERSION = "1.0.0";

export const TELEMETRY_PARSER_VERSIONS: Readonly<Record<GameId, string>> = {
  "fm-2023": "forza-udp@1",
  "f1-2025": "f1-2025-udp@1",
  acc: "acc-shared-memory@1.9",
  "ac-evo": "ac-evo-shared-memory@0.6",
  iracing: "iracing-source-frame@3",
};
