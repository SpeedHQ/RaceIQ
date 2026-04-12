import { registerServerGame } from "./registry";
import { registerGame } from "../../shared/games/registry";
import { forzaServerAdapter } from "./fm-2023";
import { f1ServerAdapter } from "./f1-2025";
import { accServerAdapter } from "./acc";
import { acEvoServerAdapter } from "./ac-evo";

/** Register all server game adapters. Call once at server startup. */
export function initServerGameAdapters(): void {
  // F1 is registered first — its canHandle() check is more specific (magic bytes),
  // so it should be tried before Forza's size-based check.
  registerServerGame(f1ServerAdapter);
  registerServerGame(forzaServerAdapter);
  registerServerGame(accServerAdapter);
  registerServerGame(acEvoServerAdapter);

  // Also update the shared registry with server adapters, which override
  // the stub name-resolution methods with real fs-backed implementations.
  registerGame(f1ServerAdapter);
  registerGame(forzaServerAdapter);
  registerGame(accServerAdapter);
  registerGame(acEvoServerAdapter);
}
