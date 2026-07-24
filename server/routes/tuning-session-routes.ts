import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema } from "../../shared/schemas";
import { GameIdSchema } from "../../shared/types";
import type { GameId, LapMeta, TelemetryPacket } from "../../shared/types";
import { getLapById, getLapsForTuningSession, getImportableLapsForTuningSession, importLapsToTuningSession, getCorners } from "../db/queries";
import { detectCorners } from "../corner-detection";
import { computeLineSpreadTrace } from "../lap-consistency";
import { selectCleanLaps } from "../ai/clean-lap-aggregate";
import { getTrackLengthMeters } from "../../shared/track-data";
import { suggestLapTarget } from "../../shared/lap-target";
import { createTuningSession, getTuningSession, listTuningSessions, updateTuningSession, setSessionHead } from "../db/tuning-session-queries";
import { getActiveTuningSession, setActiveTuningSession } from "../tuning-active";
import { deriveFuelPerLap, deriveTyreWear, type LapMetric } from "../tuning-lap-metrics";
import { createTuningTest, listTuningTests, nextVersion, getTuningTest, getLapCountsByTest, updateTuningTestSetupSnapshot, setTuningTestNote, setTuningTestNotes, deleteTestSubtree, restoreTestSubtree } from "../db/tuning-test-queries";
import { recordAction, listActions } from "../db/tuning-action-queries";
import { undoLastAction } from "../tuning-undo";
import { tuneSessionThreadId, saveChatMessages } from "../ai/chat-agent";
import { resolveGuardedSetupFile, captureF1SetupFromLaps, type AccGameId } from "../ai/setup-engineer-context";
import { nextFreeLabel } from "../ai/version-label";
import { resolveLapF1Setup, f1SetupFingerprint, summarizeF1Setup } from "../ai/f1-setup-identity";


const TuningSessionQuerySchema = z.object({
  gameId: GameIdSchema,
  includeArchived: z.coerce.boolean().optional().default(false),
});


const CreateTuningSessionSchema = z.object({
  gameId: GameIdSchema,
  name: z.string().min(1).max(120),
  carOrdinal: z.number().int().nullable().optional(),
  trackOrdinal: z.number().int().nullable().optional(),
  carName: z.string().max(200).nullable().optional(),
  trackName: z.string().max(200).nullable().optional(),
  baseSetupPath: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});


const UpdateTuningSessionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  notes: z.string().max(2000).nullable().optional(),
  baseSetupPath: z.string().max(1000).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});


const CreateTuningTestSchema = z.object({
  label: z.string().min(1).max(200),
  setupPath: z.string().max(1000).nullable().optional(),
  parentTestId: z.number().int().nullable().optional(),
  // AppliedChange[] from the autotune engine. Kept as an unknown array — the
  // client serialises whatever the engine returned; the server stores it as JSON.
  appliedChanges: z.array(z.unknown()).nullable().optional(),
  driverComment: z.string().max(2000).nullable().optional(),
  engine: z.enum(["rules", "llm"]).nullable().optional(),
});

/** PATCH a single version node — its free-text driver note and/or the

 *  engineer/AI note (independent fields, either or both may be sent). */
const UpdateTuningTestSchema = z.object({
  driverComment: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});


const AddBaseSchema = z.object({
  setupPath: z.string().min(1).max(1000),
  label: z.string().min(1).max(200).optional(),
  setHead: z.boolean().optional(),
});

/** Path params `:id/:testId` — same integer coercion as `IdParamSchema`, for

 *  routes scoped to one setup version within a session (delete/restore). */
const TestParamSchema = z.object({
  id: z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((n) => Number.isInteger(n), "id must be an integer"),
  testId: z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((n) => Number.isInteger(n), "testId must be an integer"),
});

/** `?includeDeleted=1` escape hatch (design Phase 8) — everywhere else the

 *  `/tests` list stays trash-free by default. */
const IncludeDeletedQuerySchema = z.object({
  includeDeleted: z.string().optional(),
});



const ImportLapsSchema = z.object({
  lapIds: z.array(z.number().int()).min(1).max(500),
  tuningTestId: z.number().int().nullable().optional(),
});

export const tuningSessionRoutes = new Hono()
  .get("/api/tuning-sessions",
    zValidator("query", TuningSessionQuerySchema),
    async (c) => {
      const { gameId, includeArchived } = c.req.valid("query");
      return c.json(await listTuningSessions(gameId, { includeArchived }));
    }
  )

  // POST /api/tuning-sessions — create a session (from a base setup or a
  // live/recorded session seed; car/track supplied as names or ordinals).
  // Seeds the v1 "base" tuning test from baseSetupPath when one was supplied.
  .post("/api/tuning-sessions",
    zValidator("json", CreateTuningSessionSchema),
    async (c) => {
      const body = c.req.valid("json");
      const id = await createTuningSession(body);
      // Seed v1 "base" only when the session was created from a base setup —
      // an ordinal-seeded session has no setup file to version yet.
      if (body.baseSetupPath) {
        const baseTestId = await createTuningTest({
          tuningSessionId: id,
          version: 1,
          label: "v1",
          setupPath: body.baseSetupPath,
          engine: null,
        });
        await setSessionHead(id, baseTestId);
      }
      const created = await getTuningSession(id);
      return c.json(created, 201);
    }
  )

  // POST /api/tuning-sessions/:id/activate — mark this session as the active
  // tuning session. Every lap recorded from now on is stamped with its id at
  // insert (server/tuning-active.ts + queries.ts::insertLap), so membership is
  // an explicit link independent of race sessionId — the session gathers laps
  // across every stint until deactivated.
  .post("/api/tuning-sessions/:id/activate",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      setActiveTuningSession(id);
      return c.json({ active: getActiveTuningSession() });
    }
  )

  // POST /api/tuning-sessions/:id/deactivate — clear the active tuning session,
  // but only if THIS id is the one currently active (so a stale unmount from an
  // old workspace can't clobber a session the driver has since switched to).
  .post("/api/tuning-sessions/:id/deactivate",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      if (getActiveTuningSession() === id) setActiveTuningSession(null);
      return c.json({ active: getActiveTuningSession() });
    }
  )

  // GET /api/tuning-sessions/:id/tests — the setup versions under evaluation
  // in this session (v1 base → latest), oldest-first.
  .get("/api/tuning-sessions/:id/tests",
    zValidator("param", IdParamSchema),
    zValidator("query", IncludeDeletedQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { includeDeleted } = c.req.valid("query");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const tests = await listTuningTests(id, { includeDeleted: includeDeleted === "1" });
      const counts = await getLapCountsByTest(id);
      return c.json(
        tests.map((t) => ({
          ...t,
          lapCount: counts.get(t.id)?.lapCount ?? 0,
          bestLapMs: counts.get(t.id)?.bestLapMs ?? null,
        }))
      );
    }
  )

  // POST /api/tuning-sessions/:id/tests — record a new setup version, typically
  // from a Save & recommend result (the written setup file + applied diff).
  .post("/api/tuning-sessions/:id/tests",
    zValidator("param", IdParamSchema),
    zValidator("json", CreateTuningTestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");
      const version = await nextVersion(id);
      const testId = await createTuningTest({
        tuningSessionId: id,
        version,
        label: body.label,
        setupPath: body.setupPath ?? null,
        parentTestId: body.parentTestId ?? null,
        appliedChanges: body.appliedChanges ? JSON.stringify(body.appliedChanges) : null,
        driverComment: body.driverComment ?? null,
        engine: body.engine ?? null,
      });
      const tests = await listTuningTests(id);
      const created = tests.find((t) => t.id === testId);
      return c.json(created, 201);
    }
  )

  // PATCH /api/tuning-sessions/:id/tests/:testId — edit a single version node's
  // free-text driver note (per-node annotation). Undoable via "edit-test-note".
  .patch("/api/tuning-sessions/:id/tests/:testId",
    zValidator("param", TestParamSchema),
    zValidator("json", UpdateTuningTestSchema),
    async (c) => {
      const { id, testId } = c.req.valid("param");
      const body = c.req.valid("json");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getTuningTest(testId);
      if (!test || test.tuningSessionId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }

      if (body.driverComment !== undefined) {
        const note = body.driverComment === "" ? null : body.driverComment;
        const prev = await setTuningTestNote(testId, note);
        try {
          await recordAction(id, "edit-test-note", { testId, prevDriverComment: prev });
        } catch (err: any) {
          console.error("[tune] Failed to log edit-test-note action:", err?.message);
        }
      }

      if (body.notes !== undefined) {
        const notes = body.notes === "" ? null : body.notes;
        const prev = await setTuningTestNotes(testId, notes);
        try {
          await recordAction(id, "edit-test-notes", { testId, prevNotes: prev });
        } catch (err: any) {
          console.error("[tune] Failed to log edit-test-notes action:", err?.message);
        }
      }

      return c.json(await getTuningTest(testId));
    }
  )

  // POST /api/tuning-sessions/:id/tests/:testId/delete — soft-delete a version
  // and its whole descendant subtree (design Phase 8). Reversible: status
  // flips to 'deleted' rather than removing rows, so the /restore route below
  // can flip it back. If the session head was inside the trashed subtree, it's
  // moved to the nearest surviving ancestor (or cleared, falling back to the
  // mainline tip via resolveActiveTestId).
  .post("/api/tuning-sessions/:id/tests/:testId/delete",
    zValidator("param", TestParamSchema),
    async (c) => {
      const { id, testId } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getTuningTest(testId);
      if (!test || test.tuningSessionId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }
      if (test.status === "deleted") {
        return c.json({ error: "Version is already deleted" }, 400);
      }

      const result = await deleteTestSubtree(id, testId, session.headTestId ?? null);

      try {
        await recordAction(id, "delete", {
          rootTestId: testId,
          testIds: result.deletedIds,
          prevHeadTestId: result.headMoved ? result.prevHeadTestId : null,
        });
      } catch (err: any) {
        console.error("[tune] Failed to log delete action:", err?.message);
      }

      try {
        const extra = result.deletedIds.length - 1;
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Delete **${test.label}** and its branch.` },
          {
            role: "assistant",
            markdown: `Deleted **${test.label}**${extra > 0 ? ` and ${extra} child version${extra === 1 ? "" : "s"}` : ""} — restorable from the trash.`,
          },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post delete note:", err?.message);
      }

      return c.json({ ok: true, deletedIds: result.deletedIds, headTestId: result.newHeadTestId });
    }
  )

  // POST /api/tuning-sessions/:id/tests/:testId/restore — flip a soft-deleted
  // subtree back to 'active' (design Phase 8's reversible half). Only nodes
  // currently 'deleted' within the target's subtree are restored.
  .post("/api/tuning-sessions/:id/tests/:testId/restore",
    zValidator("param", TestParamSchema),
    async (c) => {
      const { id, testId } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getTuningTest(testId);
      if (!test || test.tuningSessionId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }
      if (test.status !== "deleted") {
        return c.json({ error: "Version is not deleted" }, 400);
      }

      const restoredIds = await restoreTestSubtree(id, testId);

      try {
        await recordAction(id, "restore", { rootTestId: testId, testIds: restoredIds });
      } catch (err: any) {
        console.error("[tune] Failed to log restore action:", err?.message);
      }

      try {
        const extra = restoredIds.length - 1;
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Restore **${test.label}** from the trash.` },
          {
            role: "assistant",
            markdown: `Restored **${test.label}**${extra > 0 ? ` and ${extra} child version${extra === 1 ? "" : "s"}` : ""}.`,
          },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post restore note:", err?.message);
      }

      const restored = (await listTuningTests(id, { includeDeleted: true })).find((t) => t.id === testId);
      return c.json(restored, 200);
    }
  )

  // POST /api/tuning-sessions/:id/bases — add a second (or Nth) root to the
  // session's version forest from an existing Setups-folder file (design
  // Phase 4). Unlike branch/apply, the new node has parentTestId=null — it's
  // a fresh starting point, not a fork of anything already in the tree.
  // Posts the same kind of canned chat ack /head uses so the agent keeps
  // context on reload.
  .post("/api/tuning-sessions/:id/bases",
    zValidator("param", IdParamSchema),
    zValidator("json", AddBaseSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");
      const guarded = await resolveGuardedSetupFile(session.gameId as AccGameId, body.setupPath);
      if (!guarded.ok) return c.json({ error: guarded.error }, guarded.status);

      const tests = await listTuningTests(id);
      const takenLabels = new Set(tests.map((t) => t.label));
      const version = await nextVersion(id);
      const label = nextFreeLabel(body.label ?? `v${version}`, takenLabels);
      const testId = await createTuningTest({
        tuningSessionId: id,
        version,
        label,
        setupPath: guarded.realPath,
        parentTestId: null,
        engine: null,
      });

      const prevHeadTestId = session.headTestId ?? null;
      if (body.setHead) await setSessionHead(id, testId);

      try {
        await recordAction(id, "add-base", { testId, prevHeadTestId: body.setHead ? prevHeadTestId : null });
      } catch (err: any) {
        console.error("[tune] Failed to log add-base action:", err?.message);
      }

      try {
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Add **${label}** as a new base.` },
          {
            role: "assistant",
            markdown: body.setHead
              ? `Added **${label}** as a new base and switched to it — I'll work from here.`
              : `Added **${label}** as a new base.`,
          },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post add-base note:", err?.message);
      }

      const created = (await listTuningTests(id)).find((t) => t.id === testId);
      return c.json(created, 201);
    }
  )

  // POST /api/tuning-sessions/:id/capture-setup — F1's "Add base" affordance
  // (design Phase 10): F1 has no setup file to pick, so capture the current
  // `F1CarSetup` from the session's most recent lap's telemetry and stamp it
  // onto the active test (or a fresh base when the session has none yet).
  .post("/api/tuning-sessions/:id/capture-setup",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      if (session.gameId !== "f1-2025") {
        return c.json({ error: "Setup capture is only available for F1 2025 sessions" }, 400);
      }

      const captured = await captureF1SetupFromLaps(id);
      if (!captured) {
        return c.json({ error: "No lap with F1 setup telemetry found yet — drive a lap first." }, 400);
      }

      const tests = await listTuningTests(id);
      const activeTest = session.headTestId != null
        ? (tests.find((t) => t.id === session.headTestId) ?? (tests.length ? tests[tests.length - 1]! : null))
        : (tests.length ? tests[tests.length - 1]! : null);

      let testId: number;
      let label: string;
      let version: number;
      if (activeTest) {
        await updateTuningTestSetupSnapshot(activeTest.id, captured);
        testId = activeTest.id;
        label = activeTest.label;
        version = activeTest.version;
      } else {
        const takenLabels = new Set(tests.map((t) => t.label));
        version = await nextVersion(id);
        label = nextFreeLabel(`v${version}`, takenLabels);
        testId = await createTuningTest({
          tuningSessionId: id,
          version,
          label,
          setupSnapshot: captured,
          parentTestId: null,
          engine: null,
        });
        await setSessionHead(id, testId);
      }

      try {
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Capture current car setup.` },
          { role: "assistant", markdown: `Captured the current setup into **${label}** from telemetry.` },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post capture-setup note:", err?.message);
      }

      const updated = (await listTuningTests(id)).find((t) => t.id === testId);
      return c.json(updated, 200);
    }
  )

  // GET /api/tuning-sessions/:id/importable-laps — "Add laps from history"
  // (design Phase 6): laps matching this session's game + car + track that
  // aren't already stamped to any tuning session.
  .get("/api/tuning-sessions/:id/importable-laps",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const importable = await getImportableLapsForTuningSession(
        session.gameId as GameId,
        session.carOrdinal ?? null,
        session.trackOrdinal ?? null
      );

      if (session.gameId !== "f1-2025") {
        return c.json(importable);
      }

      // F1 only: attach setup fingerprint/summary so the import modal can
      // group laps by setup. Avoid loading telemetry for laps that already
      // have a `carSetup` snapshot — only null-carSetup laps pay that cost.
      const enriched = await Promise.all(
        importable.map(async (lap) => {
          let setup = resolveLapF1Setup({ carSetup: lap.carSetup ?? null });
          if (!setup && !lap.carSetup) {
            const full = await getLapById(lap.id);
            if (full) setup = resolveLapF1Setup({ carSetup: full.carSetup ?? null, telemetry: full.telemetry });
          }
          return {
            ...lap,
            setupFingerprint: setup ? f1SetupFingerprint(setup) : null,
            setupSummary: setup ? summarizeF1Setup(setup) : null,
          };
        })
      );
      return c.json(enriched);
    }
  )

  // POST /api/tuning-sessions/:id/import-laps — stamp a batch of history laps
  // onto this session (and optionally a specific branch/test), attaching them
  // to the aggregate the same way live-collected laps are. Posts a canned
  // chat ack so the agent picks the newly attached laps up on reload.
  .post("/api/tuning-sessions/:id/import-laps",
    zValidator("param", IdParamSchema),
    zValidator("json", ImportLapsSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");

      if (session.gameId !== "f1-2025") {
        if (body.tuningTestId != null) {
          const test = await getTuningTest(body.tuningTestId);
          if (!test || test.tuningSessionId !== id) {
            return c.json({ error: "Tuning test not found in this session" }, 404);
          }
        }

        const importedIds = await importLapsToTuningSession(
          id,
          body.lapIds,
          body.tuningTestId ?? null
        );

        try {
          await recordAction(id, "import-laps", { lapIds: importedIds });
        } catch (err: any) {
          console.error("[tune] Failed to log import-laps action:", err?.message);
        }

        try {
          await saveChatMessages(tuneSessionThreadId(id), [
            {
              role: "user",
              markdown: `Import ${body.lapIds.length} lap${body.lapIds.length === 1 ? "" : "s"} from history.`,
            },
            {
              role: "assistant",
              markdown: `Imported ${importedIds.length} lap${importedIds.length === 1 ? "" : "s"} from history${
                body.tuningTestId != null ? " into the selected version" : " into the session baseline"
              }.`,
            },
          ]);
        } catch (err: any) {
          console.error("[tune] Failed to post import-laps note:", err?.message);
        }

        return c.json({ importedIds }, 201);
      }

      // F1: auto-sort laps into setups by fingerprint — body.tuningTestId is
      // ignored, each lap's own carSetup decides where it lands.
      const existingTests = await listTuningTests(id);
      const fpToTestId = new Map<string, number>();
      for (const t of existingTests) {
        if (!t.setupSnapshot) continue;
        try {
          const snap = JSON.parse(t.setupSnapshot);
          fpToTestId.set(f1SetupFingerprint(snap), t.id);
        } catch {
          // ignore malformed snapshot
        }
      }
      const takenLabels = new Set(existingTests.map((t) => t.label));

      // group key: testId (existing/newly-created) or null for baseline
      const groups = new Map<number | null, number[]>();
      for (const lapId of body.lapIds) {
        const full = await getLapById(lapId);
        if (!full) continue;
        const setup = resolveLapF1Setup({ carSetup: full.carSetup ?? null, telemetry: full.telemetry });

        let targetTestId: number | null;
        if (!setup) {
          targetTestId = null;
        } else {
          const fp = f1SetupFingerprint(setup);
          const existing = fpToTestId.get(fp);
          if (existing != null) {
            targetTestId = existing;
          } else {
            const version = await nextVersion(id);
            const label = nextFreeLabel(`v${version}`, takenLabels);
            takenLabels.add(label);
            const newTestId = await createTuningTest({
              tuningSessionId: id,
              version,
              label,
              parentTestId: null,
              setupSnapshot: JSON.stringify(setup),
              engine: null,
            });
            fpToTestId.set(fp, newTestId);
            targetTestId = newTestId;
          }
        }

        const group = groups.get(targetTestId);
        if (group) group.push(lapId);
        else groups.set(targetTestId, [lapId]);
      }

      const importedIds: number[] = [];
      let bestGroupTestId: number | null | undefined;
      let bestGroupCount = -1;
      for (const [targetTestId, groupLapIds] of groups) {
        const ids = await importLapsToTuningSession(id, groupLapIds, targetTestId);
        importedIds.push(...ids);
        if (ids.length > bestGroupCount) {
          bestGroupCount = ids.length;
          bestGroupTestId = targetTestId;
        }
      }

      if (session.headTestId == null && bestGroupTestId != null && bestGroupCount > 0) {
        try {
          await setSessionHead(id, bestGroupTestId);
        } catch (err: any) {
          console.error("[tune] Failed to set session head after import:", err?.message);
        }
      }

      try {
        await recordAction(id, "import-laps", { lapIds: importedIds });
      } catch (err: any) {
        console.error("[tune] Failed to log import-laps action:", err?.message);
      }

      const distinctSetupCount = groups.size;
      try {
        await saveChatMessages(tuneSessionThreadId(id), [
          {
            role: "user",
            markdown: `Import ${body.lapIds.length} lap${body.lapIds.length === 1 ? "" : "s"} from history.`,
          },
          {
            role: "assistant",
            markdown: `Imported ${importedIds.length} lap${importedIds.length === 1 ? "" : "s"}, sorted into ${distinctSetupCount} setup${
              distinctSetupCount === 1 ? "" : "s"
            }.`,
          },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post import-laps note:", err?.message);
      }

      return c.json({ importedIds }, 201);
    }
  )

  // POST /api/tuning-sessions/:id/head — check out a setup version as the
  // session's current head. Posts a deterministic canned ack into the chat
  // thread (best-effort) so the Setup Engineer agent keeps context on reload.
  .post("/api/tuning-sessions/:id/head", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid session id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const testId = Number(body?.testId);
    if (!Number.isFinite(testId)) return c.json({ error: "testId is required" }, 400);

    const test = await getTuningTest(testId);
    if (!test || test.tuningSessionId !== id) {
      return c.json({ error: "Version not found in this session" }, 404);
    }

    const session = await getTuningSession(id);
    const prevHeadTestId = session?.headTestId ?? null;
    await setSessionHead(id, testId);

    try {
      await recordAction(id, "set-head", { prevHeadTestId });
    } catch (err: any) {
      console.error("[tune] Failed to log set-head action:", err?.message);
    }

    // Record the checkout as its own user action + deterministic assistant ack
    // (a distinct pair, not merged into the prior turn) so the chat reads as a
    // real exchange and the agent keeps context on reload.
    try {
      await saveChatMessages(tuneSessionThreadId(id), [
        { role: "user", markdown: `Switch head to **${test.label}**.` },
        {
          role: "assistant",
          markdown: `Switched to **${test.label}** as the current setup — I'll work from here.`,
        },
      ]);
    } catch (err: any) {
      console.error("[tune] Failed to post checkout note:", err?.message);
    }

    return c.json({ ok: true, headTestId: testId, label: test.label });
  })

  // GET /api/tuning-sessions/:id/actions — session action log, newest-first
  // (design Phase 9), for the History panel. Tiny rows (refs only), so the
  // whole session depth is returned unpaginated.
  .get("/api/tuning-sessions/:id/actions",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      return c.json(await listActions(id));
    }
  )

  // POST /api/tuning-sessions/:id/undo — reverse the newest not-yet-undone
  // action (design Phase 9). Applies the kind-specific inverse via
  // `undoLastAction` (shared with the AI's `undo_last_action` tool),
  // idempotent — a second call with nothing left pending is a no-op ok:true.
  .post("/api/tuning-sessions/:id/undo",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const result = await undoLastAction(id);

      if (result.undone) {
        try {
          await saveChatMessages(tuneSessionThreadId(id), [
            { role: "user", markdown: "Undo the last action." },
            {
              role: "assistant",
              markdown: result.warning ? `Undone — ${result.warning}` : `Undone (${result.kind}).`,
            },
          ]);
        } catch (err: any) {
          console.error("[tune] Failed to post undo note:", err?.message);
        }
      }

      return c.json(result);
    }
  )

  // GET /api/tuning-sessions/:id/lap-metrics — per-lap fuel/tyre metrics for the
  // laps this session owns (plan §2, Phase C). Derived server-side from each
  // lap's raw telemetry frames; returns a compact per-lap summary, not frame
  // dumps. Legacy laps with no stored telemetry omit their metric (never 0).
  // Tyre wear is the worst-tyre % worn at lap end, derived from the game's per-
  // tyre wear channel (see server/tuning-lap-metrics.ts); omitted when absent.
  .get("/api/tuning-sessions/:id/lap-metrics",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      // Same lap pool the workspace uses: laps explicitly linked to this tuning
      // session (migration v25), independent of race sessionId.
      const sessionLaps = await getLapsForTuningSession(id);

      const metrics: LapMetric[] = [];
      for (const lapMeta of sessionLaps) {
        const lap = await getLapById(lapMeta.id);
        const fuelPerLap = lap ? deriveFuelPerLap(lap.telemetry) : undefined;
        const tyreWear = lap ? deriveTyreWear(lap.telemetry) : undefined;
        const entry: LapMetric = { lapId: lapMeta.id };
        if (fuelPerLap != null) entry.fuelPerLap = fuelPerLap;
        if (tyreWear != null) entry.tyreWear = tyreWear;
        metrics.push(entry);
      }
      return c.json(metrics);
    }
  )

  // GET /api/tuning-sessions/:id/line-spread — trimmed (p90-p10) racing-line
  // spread trace over the session's clean lap pool, for the Track Focus
  // Consistency tab's line-spread lane + track-map heat overlay. Same
  // clean-lap selection as the Setup Engineer's evidence bundle
  // (selectCleanLaps: valid, not user-excluded, blunder-trimmed), session-wide
  // (not test/branch-scoped) to match /lap-metrics above.
  .get("/api/tuning-sessions/:id/line-spread",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      // The review page is driven by the lap ids in its URL and survives a
      // missing/orphaned session row (the core panels re-read laps directly),
      // so this lane must too: proceed on the lap pool alone, using the session
      // row only for corner metadata when present. Never 404 — return the empty
      // trace so the client shows its "need 3+ laps" state, not an error.
      const session = await getTuningSession(id);

      const pool = await getLapsForTuningSession(id);
      const { clean } = selectCleanLaps(pool);

      const loadedLaps: { meta: LapMeta; telemetry: TelemetryPacket[] }[] = [];
      for (const meta of clean) {
        const lap = await getLapById(meta.id);
        if (!lap || lap.telemetry.length < 30) continue;
        loadedLaps.push({ meta, telemetry: lap.telemetry });
      }

      if (loadedLaps.length < 3) {
        return c.json({ fracs: [], spreadM: [], perCorner: [], lowTrust: false, consistencyScore: 0, overallSpreadM: 0, lapCount: loadedLaps.length });
      }

      const fastest = [...loadedLaps].sort((a, b) => a.meta.lapTime - b.meta.lapTime)[0]!;
      let corners = session?.trackOrdinal != null && session.gameId
        ? await getCorners(session.trackOrdinal, session.gameId as GameId)
        : [];
      if (corners.length === 0) corners = detectCorners(fastest.telemetry);

      const trace = computeLineSpreadTrace(loadedLaps.map((l) => l.telemetry), corners);
      if (!trace) {
        return c.json({ fracs: [], spreadM: [], perCorner: [], lowTrust: false, consistencyScore: 0, overallSpreadM: 0, lapCount: loadedLaps.length });
      }
      return c.json(trace);
    }
  )

  // ─── Setup chat (plan §3, Phase 2) — a tool-using Setup Engineer agent, built
  //     fresh per request and bound to this session via closures (no shared
  //     mutable state, no runtimeContext). Its 5 tools (get_setup,
  //     get_symptoms, get_version_history, preview_change, apply_changes) are
  //     the ONLY action space: the model can't recommend or apply a knob the
  //     tools don't expose, and preview/apply always return the real
  //     deterministic result. apply_changes IS the old generate-from-chat path
  //     — the driver confirms in chat and the model calls it, instead of a
  //     separate endpoint. Same Mastra memory store + NDJSON stream + thread
  //     `tune-session-<id>` the previous monolithic-prompt chat used.

  // GET /api/tuning-sessions/:id/chat — thread history.
  //
  // Returns full AI-SDK v5 UIMessages (id/role/parts/metadata) instead of
  // flattened text, so a page reload restores tool-call/tool-result groups
  // and the token-usage footer exactly like a live turn does. `memory.recall`
  // only gives back the raw MastraDBMessage[] (DB shape); a MessageList is
  // Mastra's own converter from that DB shape to AI SDK v5 UIMessage shape —
  // same converter `toAISdkStream`/the agent use internally — so tool parts
  // (stored as MastraToolInvocationPart in content.parts) and any persisted
  // content.metadata (incl. usage, when present) round-trip faithfully rather
  // than being reconstructed by hand.
  .get("/api/tuning-sessions/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await getTuningSession(id);
      if (!row) return c.json({ error: "Tuning session not found" }, 404);

      const sessionLaps = await getLapsForTuningSession(id);
      const bestLap = sessionLaps.reduce<number | null>((best, l) => {
        if (!l.isValid || l.lapTime <= 0) return best;
        return best == null || l.lapTime < best ? l.lapTime : best;
      }, null);
      const trackLengthM = row.trackOrdinal != null ? getTrackLengthMeters(row.trackOrdinal, row.gameId) : null;
      const lapTarget = suggestLapTarget(bestLap, trackLengthM);

      return c.json({ ...row, lapTarget });
    }
  )

  // PATCH /api/tuning-sessions/:id — rename, note, re-point base setup, archive.
  .patch("/api/tuning-sessions/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", UpdateTuningSessionSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const before = await getTuningSession(id);
      if (!before) return c.json({ error: "Tuning session not found" }, 404);

      const updated = await updateTuningSession(id, body);
      if (!updated) return c.json({ error: "Tuning session not found" }, 404);

      // Only record the prior value of fields this PATCH actually touched, so
      // undo restores exactly what changed rather than clobbering untouched
      // fields with a stale snapshot.
      const inverse: Record<string, unknown> = {};
      if (body.name !== undefined) inverse.name = before.name;
      if (body.notes !== undefined) inverse.notes = before.notes;
      if (body.baseSetupPath !== undefined) inverse.baseSetupPath = before.baseSetupPath;
      if (body.status !== undefined) inverse.status = before.status;
      if (Object.keys(inverse).length > 0) {
        try {
          await recordAction(id, "rename-note", inverse);
        } catch (err: any) {
          console.error("[tune] Failed to log rename-note action:", err?.message);
        }
      }

      return c.json(await getTuningSession(id));
    }
  )

  // ─── Catalog ─────────────────────────────────────────────────────────────────

  // GET /api/catalog/tunes — community tunes for the game named in the
  // X-Game-Id header (no fm-2023 fallback: without a header, no tunes).
