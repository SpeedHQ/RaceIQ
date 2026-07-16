/**
 * Active tuning session — a single in-memory id for this local, single-user app.
 *
 * Mirrors the module-toggle style of pipeline.ts's setLiveIssuesEnabled: plain
 * module-level state, no DB. When a tuning-session workspace is open the client
 * activates its id here; queries.ts::insertLap reads it and stamps every newly
 * recorded lap with that tuning_session_id. This decouples tuning-session
 * membership from the race (telemetry) sessionId, so a tuning session can span
 * many race sessions / stints on the same car+track.
 *
 * Only ever one session is active at a time (single user, one workspace open).
 */
let _activeTuningSessionId: number | null = null;

export function setActiveTuningSession(id: number | null): void {
	_activeTuningSessionId = id;
}

export function getActiveTuningSession(): number | null {
	return _activeTuningSessionId;
}
