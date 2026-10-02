import { expect, type APIRequestContext, type Page } from "@playwright/test";

import type { GameId } from "../../../../shared/games/ids";
import type { LapMeta, SessionMeta } from "../../../../shared/racing/sessions/types";

export type SessionRow = Pick<SessionMeta, "id" | "source" | "notes">;

export type DisposableImport = {
  sessionIds: number[];
  lapIds: number[];
  note: string;
};

export async function sessionsFor(request: APIRequestContext, gameId: GameId): Promise<SessionRow[]> {
  const response = await request.get(`/api/sessions?gameId=${gameId}`);
  expect(response.ok(), `${gameId} session list`).toBe(true);
  return (await response.json()) as SessionRow[];
}

export async function lapsFor(request: APIRequestContext, gameId: GameId): Promise<LapMeta[]> {
  const response = await request.get(`/api/laps?gameId=${gameId}`);
  expect(response.ok(), `${gameId} lap list`).toBe(true);
  return (await response.json()) as LapMeta[];
}

export async function importDisposableLap(request: APIRequestContext, gameId: GameId, label: string, sourceLapId?: number): Promise<DisposableImport> {
  const sessionsBefore = await sessionsFor(request, gameId);
  const available = await lapsFor(request, gameId);
  const source = sourceLapId == null ? available.find((lap) => lap.isValid) : available.find((lap) => lap.id === sourceLapId);
  expect(source, `${gameId} needs a source lap for disposable import`).toBeDefined();

  const exportResponse = await request.get(`/api/laps/${source!.id}/export-bin`);
  expect(exportResponse.ok(), "seeded lap export for disposable import").toBe(true);
  const importResponse = await request.post("/api/laps/import", {
    multipart: {
      file: {
        name: `${label}.bin.gz`,
        mimeType: "application/octet-stream",
        buffer: await exportResponse.body(),
      },
      ownership: "mine",
    },
  });
  expect(importResponse.ok(), "disposable lap import").toBe(true);
  const imported = (await importResponse.json()) as { laps?: { lapId: number; sessionId: number }[] };
  const lapIds = imported.laps?.map((lap) => lap.lapId) ?? [];
  expect(lapIds.length, "disposable import lap ids").toBeGreaterThan(0);

  // Other tests can import concurrently: a before/after list difference can
  // capture their sessions and overwrite the note they are searching for.
  const sessionIds = [...new Set(imported.laps!.map((lap) => lap.sessionId))];
  const beforeIds = new Set(sessionsBefore.map((session) => session.id));
  expect(sessionIds.length, "disposable import session ids").toBeGreaterThan(0);
  for (const sessionId of sessionIds) {
    expect(Number.isInteger(sessionId), "import returns a session id").toBe(true);
    expect(beforeIds.has(sessionId), "import must not reuse a preexisting session").toBe(false);
  }
  const note = `seeded-e2e-disposable-${label}-${crypto.randomUUID()}`;
  const disposable = { sessionIds, lapIds, note };
  try {
    for (const sessionId of sessionIds) {
      const noteResponse = await request.patch(`/api/sessions/${sessionId}/notes`, { data: { notes: note } });
      expect(noteResponse.ok(), `label disposable session ${sessionId}`).toBe(true);
    }
    const sessionsAfter = await sessionsFor(request, gameId);
    for (const sessionId of sessionIds) {
      expect(sessionsAfter.find((session) => session.id === sessionId)?.notes, `persisted note for disposable session ${sessionId}`).toBe(note);
    }
    return disposable;
  } catch (error) {
    // The caller cannot clean up until this helper returns its owned IDs.
    await cleanDisposable(request, disposable, gameId);
    throw error;
  }
}

export async function cleanDisposable(request: APIRequestContext, disposable: DisposableImport | undefined, gameId: GameId = "fm-2023"): Promise<void> {
  if (!disposable) return;
  const lapsCleanup = await request.post("/api/laps/bulk-delete", { data: { ids: disposable.lapIds } });
  expect(lapsCleanup.ok(), "cleanup disposable laps").toBe(true);
  const sessionsCleanup = await request.post("/api/sessions/bulk-delete", { data: { ids: disposable.sessionIds } });
  expect(sessionsCleanup.ok(), "cleanup disposable sessions").toBe(true);
  const remaining = await sessionsFor(request, gameId);
  const remainingLaps = await lapsFor(request, gameId);
  for (const id of disposable.sessionIds) expect(remaining.some((session) => session.id === id)).toBe(false);
  for (const id of disposable.lapIds) expect(remainingLaps.some((lap) => lap.id === id)).toBe(false);
}

export function sessionRows(page: Page) {
  return page.getByRole("row").filter({ has: page.getByRole("button", { name: "Recap", exact: true }) });
}
