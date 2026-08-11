import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema, IdVersionParamSchema } from "@shared/platform/http/route-schemas";
import { getExperiment, setSessionHead } from "../../db/experiment-queries";
import {
  createExperimentVersion,
  deleteTestSubtree,
  getExperimentVersion,
  getLapCountsByTest,
  listExperimentVersions,
  nextVersion,
  restoreTestSubtree,
  setExperimentVersionNote,
  setExperimentVersionNotes,
  updateExperimentVersionSetupSnapshot,
} from "../../db/experiment-version-queries";
import { recordAction } from "../../db/experiment-action-queries";
import { tuneSessionThreadId, saveChatMessages } from "../../ai/chat-agent";
import { resolveGuardedSetupFile, type AccGameId } from "../../setups/file-guard";
import { captureF1SetupFromLaps } from "../../experiments/setup-lineage";
import { nextFreeLabel } from "../../ai/version-label";

const CreateExperimentVersionSchema = z.object({
  label: z.string().min(1).max(200),
  setupPath: z.string().max(1000).nullable().optional(),
  parentVersionId: z.number().int().nullable().optional(),
  // AppliedChange[] from the autotune engine. Kept as an unknown array — the
  // client serialises whatever the engine returned; the server stores it as JSON.
  appliedChanges: z.array(z.unknown()).nullable().optional(),
  driverComment: z.string().max(2000).nullable().optional(),
  engine: z.enum(["rules", "llm"]).nullable().optional(),
});

/** PATCH a single version node — its free-text driver note and/or the

 *  engineer/AI note (independent fields, either or both may be sent). */
const UpdateExperimentVersionSchema = z.object({
  driverComment: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});


const AddBaseSchema = z.object({
  setupPath: z.string().min(1).max(1000),
  label: z.string().min(1).max(200).optional(),
  setHead: z.boolean().optional(),
});


/** `?includeDeleted=1` escape hatch (design Phase 8) — everywhere else the

 *  `/versions` list stays trash-free by default. */
const IncludeDeletedQuerySchema = z.object({
  includeDeleted: z.string().optional(),
});



export const experimentVersionRoutes = new Hono()
  // GET /api/experiments/:id/versions — the setup versions under evaluation
  // in this session (v1 base → latest), oldest-first.
  .get("/api/experiments/:id/versions",
    zValidator("param", IdParamSchema),
    zValidator("query", IncludeDeletedQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { includeDeleted } = c.req.valid("query");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const tests = await listExperimentVersions(id, { includeDeleted: includeDeleted === "1" });
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

  // POST /api/experiments/:id/versions — record a new setup version, typically
  // from a Save & recommend result (the written setup file + applied diff).
  .post("/api/experiments/:id/versions",
    zValidator("param", IdParamSchema),
    zValidator("json", CreateExperimentVersionSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");
      const version = await nextVersion(id);
      const versionId = await createExperimentVersion({
        experimentId: id,
        version,
        label: body.label,
        setupPath: body.setupPath ?? null,
        parentVersionId: body.parentVersionId ?? null,
        appliedChanges: body.appliedChanges ? JSON.stringify(body.appliedChanges) : null,
        driverComment: body.driverComment ?? null,
        engine: body.engine ?? null,
      });
      const tests = await listExperimentVersions(id);
      const created = tests.find((t) => t.id === versionId);
      return c.json(created, 201);
    }
  )

  // PATCH /api/experiments/:id/versions/:versionId — edit a single version node's
  // free-text driver note (per-node annotation). Undoable via "edit-test-note".
  .patch("/api/experiments/:id/versions/:versionId",
    zValidator("param", IdVersionParamSchema),
    zValidator("json", UpdateExperimentVersionSchema),
    async (c) => {
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getExperimentVersion(versionId);
      if (!test || test.experimentId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }

      if (body.driverComment !== undefined) {
        const note = body.driverComment === "" ? null : body.driverComment;
        const prev = await setExperimentVersionNote(versionId, note);
        try {
          await recordAction(id, "edit-test-note", { versionId, prevDriverComment: prev });
        } catch (err: any) {
          console.error("[tune] Failed to log edit-test-note action:", err?.message);
        }
      }

      if (body.notes !== undefined) {
        const notes = body.notes === "" ? null : body.notes;
        const prev = await setExperimentVersionNotes(versionId, notes);
        try {
          await recordAction(id, "edit-test-notes", { versionId, prevNotes: prev });
        } catch (err: any) {
          console.error("[tune] Failed to log edit-test-notes action:", err?.message);
        }
      }

      return c.json(await getExperimentVersion(versionId));
    }
  )

  // POST /api/experiments/:id/versions/:versionId/delete — soft-delete a version
  // and its whole descendant subtree (design Phase 8). Reversible: status
  // flips to 'deleted' rather than removing rows, so the /restore route below
  // can flip it back. If the session head was inside the trashed subtree, it's
  // moved to the nearest surviving ancestor (or cleared, falling back to the
  // mainline tip via resolveActiveTestId).
  .post("/api/experiments/:id/versions/:versionId/delete",
    zValidator("param", IdVersionParamSchema),
    async (c) => {
      const { id, versionId } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getExperimentVersion(versionId);
      if (!test || test.experimentId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }
      if (test.status === "deleted") {
        return c.json({ error: "Version is already deleted" }, 400);
      }

      const result = await deleteTestSubtree(id, versionId, session.headVersionId ?? null);

      try {
        await recordAction(id, "delete", {
          rootTestId: versionId,
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

      return c.json({ ok: true, deletedIds: result.deletedIds, headVersionId: result.newHeadTestId });
    }
  )

  // POST /api/experiments/:id/versions/:versionId/restore — flip a soft-deleted
  // subtree back to 'active' (design Phase 8's reversible half). Only nodes
  // currently 'deleted' within the target's subtree are restored.
  .post("/api/experiments/:id/versions/:versionId/restore",
    zValidator("param", IdVersionParamSchema),
    async (c) => {
      const { id, versionId } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      const test = await getExperimentVersion(versionId);
      if (!test || test.experimentId !== id) {
        return c.json({ error: "Version not found in this session" }, 404);
      }
      if (test.status !== "deleted") {
        return c.json({ error: "Version is not deleted" }, 400);
      }

      const restoredIds = await restoreTestSubtree(id, versionId);

      try {
        await recordAction(id, "restore", { rootTestId: versionId, testIds: restoredIds });
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

      const restored = (await listExperimentVersions(id, { includeDeleted: true })).find((t) => t.id === versionId);
      return c.json(restored, 200);
    }
  )

  // POST /api/experiments/:id/bases — add a second (or Nth) root to the
  // session's version forest from an existing Setups-folder file (design
  // Phase 4). Unlike branch/apply, the new node has parentVersionId=null — it's
  // a fresh starting point, not a fork of anything already in the tree.
  // Posts the same kind of canned chat ack /head uses so the agent keeps
  // context on reload.
  .post("/api/experiments/:id/bases",
    zValidator("param", IdParamSchema),
    zValidator("json", AddBaseSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");
      const guarded = await resolveGuardedSetupFile(session.gameId as AccGameId, body.setupPath);
      if (!guarded.ok) return c.json({ error: guarded.error }, guarded.status);

      const tests = await listExperimentVersions(id);
      const takenLabels = new Set(tests.map((t) => t.label));
      const version = await nextVersion(id);
      const label = nextFreeLabel(body.label ?? `v${version}`, takenLabels);
      const versionId = await createExperimentVersion({
        experimentId: id,
        version,
        label,
        setupPath: guarded.realPath,
        parentVersionId: null,
        engine: null,
      });

      const prevHeadTestId = session.headVersionId ?? null;
      if (body.setHead) await setSessionHead(id, versionId);

      try {
        await recordAction(id, "add-base", { versionId, prevHeadTestId: body.setHead ? prevHeadTestId : null });
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

      const created = (await listExperimentVersions(id)).find((t) => t.id === versionId);
      return c.json(created, 201);
    }
  )

  // POST /api/experiments/:id/capture-setup — F1's "Add base" affordance
  // (design Phase 10): F1 has no setup file to pick, so capture the current
  // `F1CarSetup` from the session's most recent lap's telemetry and stamp it
  // onto the active test (or a fresh base when the session has none yet).
  .post("/api/experiments/:id/capture-setup",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      if (session.gameId !== "f1-2025") {
        return c.json({ error: "Setup capture is only available for F1 2025 sessions" }, 400);
      }

      const captured = await captureF1SetupFromLaps(id);
      if (!captured) {
        return c.json({ error: "No lap with F1 setup telemetry found yet — drive a lap first." }, 400);
      }

      const tests = await listExperimentVersions(id);
      const activeTest = session.headVersionId != null
        ? (tests.find((t) => t.id === session.headVersionId) ?? (tests.length ? tests[tests.length - 1]! : null))
        : (tests.length ? tests[tests.length - 1]! : null);

      let versionId: number;
      let label: string;
      let version: number;
      if (activeTest) {
        await updateExperimentVersionSetupSnapshot(activeTest.id, captured);
        versionId = activeTest.id;
        label = activeTest.label;
        version = activeTest.version;
      } else {
        const takenLabels = new Set(tests.map((t) => t.label));
        version = await nextVersion(id);
        label = nextFreeLabel(`v${version}`, takenLabels);
        versionId = await createExperimentVersion({
          experimentId: id,
          version,
          label,
          setupSnapshot: captured,
          parentVersionId: null,
          engine: null,
        });
        await setSessionHead(id, versionId);
      }

      try {
        await saveChatMessages(tuneSessionThreadId(id), [
          { role: "user", markdown: `Capture current car setup.` },
          { role: "assistant", markdown: `Captured the current setup into **${label}** from telemetry.` },
        ]);
      } catch (err: any) {
        console.error("[tune] Failed to post capture-setup note:", err?.message);
      }

      const updated = (await listExperimentVersions(id)).find((t) => t.id === versionId);
      return c.json(updated, 200);
    }
  );

// POST /api/experiments/:id/head — check out a setup version as the
// session's current head. Posts a deterministic canned ack into the chat
// thread (best-effort) so the Setup Engineer agent keeps context on reload.
export const experimentHeadRoutes = new Hono()
  .post("/api/experiments/:id/head", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid session id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const versionId = Number(body?.versionId);
    if (!Number.isFinite(versionId)) return c.json({ error: "versionId is required" }, 400);

    const test = await getExperimentVersion(versionId);
    if (!test || test.experimentId !== id) {
      return c.json({ error: "Version not found in this session" }, 404);
    }
    if (test.status === "deleted") {
      return c.json({ error: "Cannot checkout a deleted version" }, 400);
    }

    const session = await getExperiment(id);
    if (!session) return c.json({ error: "Tuning session not found" }, 404);
    const prevHeadTestId = session.headVersionId ?? null;
    await setSessionHead(id, versionId);
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

    return c.json({ ok: true, headVersionId: versionId, label: test.label });
  });
