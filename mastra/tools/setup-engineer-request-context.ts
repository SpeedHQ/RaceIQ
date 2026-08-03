/**
 * Leaf module: read the Setup Engineer's per-request context.
 *
 * The setup-engineer tools are static module-level singletons registered on the
 * Mastra instance. Per-session values (`gameId`, `sessionId`) are NOT closed
 * over and NOT supplied by the model as tool args — the weak local chat models
 * routinely dropped the `sessionId` arg, forcing a failed call + retry. Instead
 * the chat route sets them once per turn via Mastra's `requestContext`, and each
 * tool reads them here.
 *
 * Kept dependency-free (only a type-only import) so the guard is unit-testable
 * without pulling in the DB/fs/memory graph the tool file imports.
 */
import type { GameId } from "../../shared/games/ids";

/** Mastra's RequestContext is a Map-like class; we only need `.get(key)`. */
export interface RequestContextLike {
  get(key: string): unknown;
}

export interface SetupEngineerRequestContext {
  gameId: GameId;
  sessionId: number;
}

/**
 * Extract and validate `{ gameId, sessionId }` from the request context. Throws
 * a clear error when the route forgot to set them, rather than letting a tool
 * run against `undefined` and produce a confusing downstream failure.
 */
export function readSetupEngineerContext(
  requestContext: RequestContextLike | undefined,
): SetupEngineerRequestContext {
  const gameId = requestContext?.get("gameId") as GameId | undefined;
  const sessionId = requestContext?.get("sessionId") as number | undefined;
  if (!gameId || typeof sessionId !== "number" || !Number.isFinite(sessionId)) {
    throw new Error(
      "setup-engineer tool called without gameId/sessionId in requestContext — " +
        "the chat route must set requestContext: { gameId, sessionId } on the run.",
    );
  }
  return { gameId, sessionId };
}
