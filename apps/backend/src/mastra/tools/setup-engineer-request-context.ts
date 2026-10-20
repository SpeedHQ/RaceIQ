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
import type { ExperimentChatBranchContext } from "../../experiments/chat-branch-context";
import type { GameId } from "@raceiq/shared/games/ids";

/** Mastra's RequestContext is a Map-like class; we only need `.get(key)`. */
export interface RequestContextLike {
  get(key: string): unknown;
}

export const EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY = "raceiq.experimentChatBranch";

export interface TurnMutationState {
  expectedHeadVersionId: number | null;
  createdLabels: Set<string>;
}

export interface SetupEngineerRequestContext {
  gameId: GameId;
  sessionId: number;
  branch: ExperimentChatBranchContext;
  mutations: TurnMutationState;
}

const TURN_MUTATION_STATE_KEY = "raceiq.experimentTurnMutations";

/** Mutable CAS head is separate from immutable branch evidence captured at admission. */
export function readTurnMutationState(
  requestContext: RequestContextLike | undefined,
  branch: ExperimentChatBranchContext,
): TurnMutationState {
  const existing = requestContext?.get(TURN_MUTATION_STATE_KEY) as TurnMutationState | undefined;
  if (existing) return existing;
  const state = { expectedHeadVersionId: branch.headVersionId, createdLabels: new Set<string>() };
  (requestContext as RequestContextLike & { set?: (key: string, value: unknown) => void } | undefined)
    ?.set?.(TURN_MUTATION_STATE_KEY, state);
  return state;
}

/** Extract and validate server-bound `{ gameId, sessionId, branch }`. */
export function readSetupEngineerContext(
  requestContext: RequestContextLike | undefined,
): SetupEngineerRequestContext {
  const gameId = requestContext?.get("gameId") as GameId | undefined;
  const sessionId = requestContext?.get("sessionId") as number | undefined;
  const branch = requestContext?.get(EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY) as ExperimentChatBranchContext | undefined;
  if (!gameId || typeof sessionId !== "number" || !Number.isFinite(sessionId) ||
      !branch || branch.sessionId !== sessionId || !Array.isArray(branch.lapIds) ||
      !Array.isArray(branch.versions) || !Array.isArray(branch.laps)) {
    throw new Error("setup-engineer tool called without valid server-bound experiment branch context.");
  }
  return { gameId, sessionId, branch, mutations: readTurnMutationState(requestContext, branch) };
}
