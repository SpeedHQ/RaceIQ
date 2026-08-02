import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema } from "../../../shared/schemas";
import { GameIdSchema } from "../../../shared/types";
import { getActiveExperiment, setActiveExperiment } from "../../experiments/active";
import { createExperiment, getExperiment, listExperimentFocusEvents, listExperiments, setExperimentFocus, setSessionHead, updateExperiment } from "../../db/experiment-queries";
import { createExperimentVersion } from "../../db/experiment-version-queries";
import { getLapsForExperiment } from "../../db/experiment-lap-queries";
import { recordAction } from "../../db/experiment-action-queries";
import { getTrackLengthMeters } from "../../../shared/track-data";
import { suggestLapTarget } from "../../../shared/lap-target";
import { ExperimentFocusSchema } from "../../../shared/experiment-focus";

const ExperimentQuerySchema = z.object({
  gameId: GameIdSchema,
  includeArchived: z.coerce.boolean().optional().default(false),
});

const CreateExperimentSchema = z.object({
  gameId: GameIdSchema,
  name: z.string().min(1).max(120),
  carOrdinal: z.number().int().nullable().optional(),
  trackOrdinal: z.number().int().nullable().optional(),
  carName: z.string().max(200).nullable().optional(),
  trackName: z.string().max(200).nullable().optional(),
  baseSetupPath: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // What the experiment opens on. Mutable afterwards — see PATCH .../focus.
  focus: ExperimentFocusSchema.optional(),
});

/** Switch what the experiment is working on. `note` is the driver's own reason,
 *  never inferred. */
const SetFocusSchema = z.object({
  focus: ExperimentFocusSchema,
  note: z.string().max(2000).nullable().optional(),
});

const UpdateExperimentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  notes: z.string().max(2000).nullable().optional(),
  baseSetupPath: z.string().max(1000).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

export const experimentLifecycleRoutes = new Hono()
  .get("/api/experiments",
    zValidator("query", ExperimentQuerySchema),
    async (c) => {
      const { gameId, includeArchived } = c.req.valid("query");
      return c.json(await listExperiments(gameId, { includeArchived }));
    }
  )

  // POST /api/experiments — create a session (from a base setup or a
  // live/recorded session seed; car/track supplied as names or ordinals).
  // Seeds the v1 "base" tuning test from baseSetupPath when one was supplied.
  .post("/api/experiments",
    zValidator("json", CreateExperimentSchema),
    async (c) => {
      const body = c.req.valid("json");
      const id = await createExperiment(body);
      // Seed v1 "base" only when the session was created from a base setup —
      // an ordinal-seeded session has no setup file to version yet.
      if (body.baseSetupPath) {
        const baseTestId = await createExperimentVersion(
          {
            experimentId: id,
            version: 1,
            label: "v1",
            setupPath: body.baseSetupPath,
            engine: null,
            // Explicitly a setup arm even when the experiment opens on driving
            // focus: v1 IS the base setup file. Letting focus decide here would
            // record the driver's own starting car as a drill.
            kind: "setup",
          }
        );
        await setSessionHead(id, baseTestId);
      }
      const created = await getExperiment(id);
      return c.json(created, 201);
    }
  )

  // PATCH /api/experiments/:id/focus — switch what the experiment is working
  // on (tuning the car vs working on technique) mid-session, and append the
  // switch to the focus ledger.
  //
  // Deliberately not part of PATCH /api/experiments: this is not an edit to a
  // field, it starts a new era in the session. It changes what kind the NEXT
  // arm gets and leaves every existing arm exactly as it was.
  .patch("/api/experiments/:id/focus",
    zValidator("param", IdParamSchema),
    zValidator("json", SetFocusSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { focus, note } = c.req.valid("json");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Experiment not found" }, 404);

      const event = await setExperimentFocus(id, focus, { note: note ?? null });
      // `event` is null when the focus was already what was asked for. That is
      // success, not an error — the caller's desired state holds — but nothing
      // is appended to the ledger for it.
      const updated = await getExperiment(id);
      return c.json({ experiment: updated, event, changed: event != null });
    }
  )

  // GET /api/experiments/:id/focus-history — the focus ledger, oldest first.
  // Reads as the session's timeline: opened on setup, moved to driving at v4.
  .get("/api/experiments/:id/focus-history",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Experiment not found" }, 404);
      return c.json(await listExperimentFocusEvents(id));
    }
  )

  // POST /api/experiments/:id/activate — mark this session as the active
  // tuning session. Every lap recorded from now on is stamped with its id at
  // insert (server/experiments/active.ts + db/lap-mutation-queries.ts::insertLap), so membership is
  // an explicit link independent of race sessionId — the session gathers laps
  // across every stint until deactivated.
  .post("/api/experiments/:id/activate",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      setActiveExperiment(id);
      return c.json({ active: getActiveExperiment() });
    }
  )

  // POST /api/experiments/:id/deactivate — clear the active tuning session,
  // but only if THIS id is the one currently active (so a stale unmount from an
  // old workspace can't clobber a session the driver has since switched to).
  .post("/api/experiments/:id/deactivate",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      if (getActiveExperiment() === id) setActiveExperiment(null);
      return c.json({ active: getActiveExperiment() });
    }
  );

export const experimentDetailRoutes = new Hono()
  .get("/api/experiments/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await getExperiment(id);
      if (!row) return c.json({ error: "Tuning session not found" }, 404);

      const sessionLaps = await getLapsForExperiment(id);
      const bestLap = sessionLaps.reduce<number | null>((best, l) => {
        if (!l.isValid || l.lapTime <= 0) return best;
        return best == null || l.lapTime < best ? l.lapTime : best;
      }, null);
      const trackLengthM = row.trackOrdinal != null ? getTrackLengthMeters(row.trackOrdinal, row.gameId) : null;
      const lapTarget = suggestLapTarget(bestLap, trackLengthM);

      return c.json({ ...row, lapTarget });
    }
  )

  // PATCH /api/experiments/:id — rename, note, re-point base setup, archive.
  .patch("/api/experiments/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", UpdateExperimentSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const before = await getExperiment(id);
      if (!before) return c.json({ error: "Tuning session not found" }, 404);

      const updated = await updateExperiment(id, body);
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

      return c.json(await getExperiment(id));
    }
  );
