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

export async function importDisposableLap(request: APIRequestContext, gameId: GameId, label: string): Promise<DisposableImport> {
  const sessionsBefore = await sessionsFor(request, gameId);
  const source = (await lapsFor(request, gameId)).find((lap) => lap.isValid);
  expect(source, `${gameId} needs valid lap for disposable import`).toBeDefined();

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
  const imported = (await importResponse.json()) as { laps?: { lapId: number }[] };
  const lapIds = imported.laps?.map((lap) => lap.lapId) ?? [];
  expect(lapIds.length, "disposable import lap ids").toBeGreaterThan(0);

  const sessionsAfter = await sessionsFor(request, gameId);
  const beforeIds = new Set(sessionsBefore.map((session) => session.id));
  const sessionIds = sessionsAfter.filter((session) => !beforeIds.has(session.id)).map((session) => session.id);
  expect(sessionIds.length, "disposable import session ids").toBeGreaterThan(0);
  const note = `seeded-e2e-disposable-${label}-${Date.now()}`;
  for (const sessionId of sessionIds) {
    const noteResponse = await request.patch(`/api/sessions/${sessionId}/notes`, { data: { notes: note } });
    expect(noteResponse.ok(), `label disposable session ${sessionId}`).toBe(true);
  }
  return { sessionIds, lapIds, note };
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
