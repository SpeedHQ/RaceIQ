const activeBySession = new Map<number, symbol>();

export class SessionSourceMutationActiveError extends Error {
  constructor(sessionId: number) {
    super(`Session ${sessionId} source mutation is already active`);
    this.name = "SessionSourceMutationActiveError";
  }
}

/** Mark exclusive main-process capture/import/reprocess ownership for host readiness checks. */
export function beginSessionSourceMutation(sessionId: number): () => void {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new RangeError("Invalid session ID for source mutation");
  if (activeBySession.has(sessionId)) throw new SessionSourceMutationActiveError(sessionId);
  const owner = Symbol(`source-mutation:${sessionId}`);
  activeBySession.set(sessionId, owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeBySession.get(sessionId) === owner) activeBySession.delete(sessionId);
  };
}

/** Main-host metadata proof for work that can invalidate a session's source artifacts. */
export function isSessionSourceMutationActive(sessionId: number): boolean {
  return activeBySession.has(sessionId);
}
