import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { existsSync } from "fs";

import type { GameId } from "../shared/games/ids";
import type { LapMeta, SessionMeta } from "../shared/racing/sessions/types";
import { collectBrowserErrors } from "./seeded-e2e-helpers";

type SessionRow = Pick<SessionMeta, "id" | "source" | "notes">;

type DisposableImport = {
  sessionIds: number[];
  lapIds: number[];
  note: string;
};

async function sessionsFor(request: APIRequestContext, gameId: GameId): Promise<SessionRow[]> {
  const response = await request.get(`/api/sessions?gameId=${gameId}`);
  expect(response.ok(), `${gameId} session list`).toBe(true);
  return (await response.json()) as SessionRow[];
}

async function lapsFor(request: APIRequestContext, gameId: GameId): Promise<LapMeta[]> {
  const response = await request.get(`/api/laps?gameId=${gameId}`);
  expect(response.ok(), `${gameId} lap list`).toBe(true);
  return (await response.json()) as LapMeta[];
}

async function importDisposableLap(request: APIRequestContext, gameId: GameId, label: string): Promise<DisposableImport> {
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

async function cleanDisposable(request: APIRequestContext, disposable: DisposableImport | undefined, gameId: GameId = "fm-2023"): Promise<void> {
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

async function sessionRows(page: Page) {
  return page.getByRole("row").filter({ has: page.getByRole("button", { name: "Recap", exact: true }) });
}

test("sessions filter, notes, recap, export, and deletion confirmation preserve seeded data", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const seededBefore = await sessionsFor(request, "fm-2023");
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

  const search = page.getByPlaceholder("Search track, car, notes…");
  await search.fill("definitely-no-seeded-session");
  await expect(page.getByText("No sessions recorded yet", { exact: true }).last()).toBeVisible();
  await search.fill("");

  const firstRow = (await sessionRows(page)).first();
  await expect(firstRow).toBeVisible();
  await firstRow.getByRole("button", { name: "Recap", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Best lap", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await firstRow.getByRole("button", { name: "Export", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.zip$/);

  const noteButton = firstRow.locator("td").last().getByRole("button");
  const replacementNote = `seeded-e2e-note-${Date.now()}`;
  await noteButton.click();
  const noteDialog = page.getByRole("dialog");
  const originalNote = await noteDialog.getByRole("textbox").inputValue();
  let noteRestored = false;
  try {
    await noteDialog.getByRole("textbox").fill(replacementNote);
    const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && /\/api\/sessions\/\d+\/notes$/.test(new URL(response.url()).pathname));
    await noteDialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saveResponse).ok()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await search.fill(replacementNote);
    await expect(page.getByText(replacementNote, { exact: true }).last()).toBeVisible();

    await search.fill("");
    const selection = (await sessionRows(page)).first().getByRole("checkbox");
    await selection.check();
    await page.getByRole("button", { name: /^Delete / }).click();
    await expect(page.getByText("Confirm?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Delete / })).toBeVisible();
    await selection.uncheck();

    const restored = await request.patch(`/api/sessions/${seededBefore[0]?.id}/notes`, { data: { notes: originalNote || null } });
    expect(restored.ok(), "restore seeded note").toBe(true);
    noteRestored = true;
    const seededAfter = await sessionsFor(request, "fm-2023");
    expect(new Set(seededAfter.map((session) => session.id))).toEqual(new Set(seededBefore.map((session) => session.id)));
    expect(seededAfter.find((session) => session.id === seededBefore[0]?.id)?.notes ?? null).toBe(originalNote || null);
    expect(browserErrors.errors).toEqual([]);
  } finally {
    if (!noteRestored) {
      const restored = await request.patch(`/api/sessions/${seededBefore[0]?.id}/notes`, { data: { notes: originalNote || null } });
      expect(restored.ok(), "restore seeded note after failure").toBe(true);
    }
  }
});

test("sessions recorded and imported tabs expose true-empty state", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/ac-evo/sessions?tab=imported", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Imported", exact: true })).toHaveAttribute("class", /bg-app-accent/);
  const search = page.getByPlaceholder("Search track, car, notes…");
  await search.fill("definitely-no-imported-session");
  await expect(page.getByText("No imported logs yet", { exact: true }).last()).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "Recorded", exact: true }).click();
  await expect(page).toHaveURL(/\/ac-evo\/sessions(?:\?.*)?$/);
  await expect(page.getByRole("button", { name: "Recorded", exact: true })).toHaveAttribute("class", /bg-app-accent/);
  expect(browserErrors.errors).toEqual([]);
});

test("sessions pagination advances when seeded data exceeds one page", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const rows = await sessionRows(page);
  const seededCount = await rows.count();
  const next = page.getByRole("button", { name: "Next", exact: true });
  if (await next.count() === 0) {
    expect(browserErrors.errors).toEqual([]);
    return;
  }
  await expect(next).toBeEnabled();
  const showingBefore = await page.getByText(/Showing\s+1–/).first().innerText();
  await next.click();
  await expect(page.getByText(new RegExp(`Showing\\s+${Math.min(26, seededCount + 1)}–`)).first()).toBeVisible();
  expect(await page.getByRole("button", { name: "Previous", exact: true }).isEnabled()).toBe(true);
  expect(showingBefore).not.toEqual(await page.getByText(/Showing\s+1–/).first().innerText().catch(() => ""));
  expect(browserErrors.errors).toEqual([]);
});

test("sessions analyse and compare navigation uses selected seeded laps", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const sessions = await sessionsFor(request, "fm-2023");
  const laps = await lapsFor(request, "fm-2023");
  const targetSessionIndex = sessions.findIndex(
    (session) => laps.filter((lap) => lap.sessionId === session.id && lap.isValid).length >= 2,
  );
  expect(targetSessionIndex, "seeded session with two valid laps").toBeGreaterThanOrEqual(0);
  expect(targetSessionIndex, "two-lap seeded session must be on first page").toBeLessThan(25);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const first = (await sessionRows(page)).nth(targetSessionIndex);
  await first.click();
  const lapRows = page.locator("tbody tbody tr").filter({ has: page.getByRole("button", { name: "Analyse", exact: true }) });
  await expect(lapRows.nth(0)).toBeVisible();
  await expect(lapRows.nth(1)).toBeVisible();
  await lapRows.nth(0).getByRole("checkbox").check();
  await lapRows.nth(1).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Compare 2 laps", exact: true }).click();
  await expect(page).toHaveURL(/\/fm23\/compare\?/);

  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  const analyseSession = (await sessionRows(page)).first();
  await analyseSession.click();
  await page.locator("tbody tbody tr").filter({ has: page.getByRole("button", { name: "Analyse", exact: true }) }).first().getByRole("button", { name: "Analyse", exact: true }).click();
  await expect(page).toHaveURL(/\/fm23\/analyse\?/);
  expect(browserErrors.errors).toEqual([]);
});

test("session lap context action rechecks disposable imported lap", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  let disposable: DisposableImport | undefined;
  try {
    disposable = await importDisposableLap(request, "fm-2023", "sessions-context");
    await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
    const search = page.getByPlaceholder("Search track, car, notes…");
    await search.fill(disposable.note);
    const row = (await sessionRows(page)).first();
    await expect(row).toBeVisible();
    await row.click();
    const lapRow = page.locator("tbody tbody tr").filter({ has: page.getByRole("button", { name: "Analyse", exact: true }) }).first();
    await expect(lapRow).toBeVisible();
    await lapRow.click({ button: "right" });
    await expect(page.getByRole("button", { name: "Recheck validity", exact: true })).toBeVisible();
    const recheck = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/laps\/\d+\/recheck$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Recheck validity", exact: true }).click();
    const recheckResponse = await recheck;
    expect(recheckResponse.ok()).toBe(true);
    const result = (await recheckResponse.json()) as { id: number; valid: boolean };
    const persisted = (await lapsFor(request, "fm-2023")).find((lap) => lap.id === result.id);
    expect(persisted?.isValid).toBe(result.valid);
    expect(browserErrors.errors).toEqual([]);
  } finally {
    await cleanDisposable(request, disposable);
  }
});

test("successful session deletion removes only disposable API-created record", async ({ page, request }) => {
  const seededBefore = await sessionsFor(request, "fm-2023");
  let disposable: DisposableImport | undefined;
  try {
    disposable = await importDisposableLap(request, "fm-2023", "sessions-delete");
    const browserErrors = collectBrowserErrors(page);
    await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Search track, car, notes…").fill(disposable.note);
    const row = (await sessionRows(page)).first();
    await expect(row).toBeVisible();
    await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: /^Delete / }).click();
    const deleted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/sessions/bulk-delete");
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    expect((await deleted).ok()).toBe(true);
    await expect(row).toHaveCount(0);
    const after = await sessionsFor(request, "fm-2023");
    expect(new Set(after.map((session) => session.id))).toEqual(new Set(seededBefore.map((session) => session.id)));
    disposable = undefined;
    expect(browserErrors.errors).toEqual([]);
  } finally {
    if (disposable) await cleanDisposable(request, disposable);
  }
});

const MOTEC_FIXTURES = [
  "test/fixtures/motec.ld",
  "test/fixtures/motec.ldx",
  "test-data-seeded/motec/example.ld",
] as const;
const motecLd = MOTEC_FIXTURES.find((path) => path.endsWith(".ld") && existsSync(path));
const motecLdx = MOTEC_FIXTURES.find((path) => path.endsWith(".ldx") && existsSync(path));

test("MoTeC import fixture creates disposable imported session when repository evidence exists", async ({ page, request }) => {
  test.skip(!motecLd, "No repository MoTeC .ld fixture available");
  if (!motecLd) return;
  const browserErrors = collectBrowserErrors(page);
  const sessionsBefore = await sessionsFor(request, "ac-evo");
  const carsResponse = await request.get("/api/ac-evo/cars");
  const tracksResponse = await request.get("/api/tracks?gameId=ac-evo");
  expect(carsResponse.ok()).toBe(true);
  expect(tracksResponse.ok()).toBe(true);
  const cars = (await carsResponse.json()) as { ordinal: number }[];
  const tracks = (await tracksResponse.json()) as { ordinal: number }[];
  expect(cars.length).toBeGreaterThan(0);
  expect(tracks.length).toBeGreaterThan(0);
  const multipart: Parameters<typeof request.post>[1] = {
    multipart: {
      file: { name: "repository.ld", mimeType: "application/octet-stream", path: motecLd },
      ...(motecLdx ? { ldx: { name: "repository.ldx", mimeType: "application/xml", path: motecLdx } } : {}),
      gameId: "ac-evo",
      carOrdinal: String(cars[0].ordinal),
      trackOrdinal: String(tracks[0].ordinal),
    },
  };
  let importedLapIds: number[] = [];
  let importedSessionIds: number[] = [];
  try {
    const importedResponse = await request.post("/api/laps/import-motec", multipart);
    expect(importedResponse.ok()).toBe(true);
    const imported = (await importedResponse.json()) as { laps?: { lapId: number }[] };
    importedLapIds = imported.laps?.map((lap) => lap.lapId) ?? [];
    expect(importedLapIds.length).toBeGreaterThan(0);
    const sessionsAfter = await sessionsFor(request, "ac-evo");
    const beforeIds = new Set(sessionsBefore.map((session) => session.id));
    importedSessionIds = sessionsAfter.filter((session) => !beforeIds.has(session.id)).map((session) => session.id);
    expect(importedSessionIds.length).toBeGreaterThan(0);
    await page.goto("/ac-evo/sessions?tab=imported", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("MoTeC", { exact: true }).last()).toBeVisible();
    expect(browserErrors.errors).toEqual([]);
  } finally {
    const lapCleanup = await request.post("/api/laps/bulk-delete", { data: { ids: importedLapIds } });
    expect(lapCleanup.ok()).toBe(true);
    const sessionCleanup = await request.post("/api/sessions/bulk-delete", { data: { ids: importedSessionIds } });
    expect(sessionCleanup.ok()).toBe(true);
    const finalSessions = await sessionsFor(request, "ac-evo");
    const finalLaps = await lapsFor(request, "ac-evo");
    for (const id of importedSessionIds) expect(finalSessions.some((session) => session.id === id)).toBe(false);
    for (const id of importedLapIds) expect(finalLaps.some((lap) => lap.id === id)).toBe(false);
  }
});
test("sessions loading and API error states remain visible", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const seeded = await sessionsFor(request, "fm-2023");
  let releaseLoading!: () => void;
  const loading = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  await page.route("**/api/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/sessions" || url.searchParams.get("gameId") !== "fm-2023") return route.continue();
    await loading;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(seeded) });
  });
  const navigation = page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading...", { exact: true }).last()).toBeVisible();
  releaseLoading();
  await navigation;
  await page.unroute("**/api/sessions**");
  expect(browserErrors.errors).toEqual([]);

  await page.route("**/api/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/sessions" || url.searchParams.get("gameId") !== "fm-2023") return route.continue();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "seeded e2e outage" }) });
  });
  const errorPageErrors = collectBrowserErrors(page);
  await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert").filter({ hasText: "Error" })).toBeVisible();
  expect(errorPageErrors.errors.filter((error) => error !== "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)" && !error.startsWith("http 503:"))).toEqual([]);
  await page.unroute("**/api/sessions**");
});
