import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema } from "../../../shared/schemas";
import type { GameId, LapMeta, TelemetryPacket } from "../../../shared/types";
import { getLapById, getLapsByIds } from "../../db/lap-read-queries";
import { getLapsForExperiment, getImportableLapsForExperiment, importLapsToExperiment } from "../../db/experiment-lap-queries";
import { getCorners } from "../../db/track-queries";
import { setLapMetrics } from "../../db/lap-mutation-queries";
import { lineSpreadLapSetHash, getLineSpreadCache, setLineSpreadCache } from "../../db/line-spread-cache-queries";
import { getExperiment, setSessionHead } from "../../db/experiment-queries";
import { createExperimentVersion, getExperimentVersion, listExperimentVersions, nextVersion } from "../../db/experiment-version-queries";
import { recordAction } from "../../db/experiment-action-queries";
import { detectCorners } from "../../lap-analysis/corners";
import { computeLineSpreadTrace } from "../../lap-analysis/consistency";
import { selectCleanLaps } from "../../experiments/lap-evidence/selection";
import { fastestLaps } from "../../../shared/review-laps";
import { deriveFuelPerLap, deriveTyreWear, type LapMetric } from "../../lap-analysis/metrics";
import { tuneSessionThreadId, saveChatMessages } from "../../ai/chat-agent";
import { nextFreeLabel } from "../../ai/version-label";
import { resolveLapF1Setup, f1SetupFingerprint, summarizeF1Setup } from "../../ai/f1-setup-identity";

const ImportLapsSchema = z.object({
  lapIds: z.array(z.number().int()).min(1).max(500),
  experimentVersionId: z.number().int().nullable().optional(),
});

export const experimentLapRoutes = new Hono()
  // GET /api/experiments/:id/importable-laps — "Add laps from history"
  // (design Phase 6): laps matching this session's game + car + track that
  // aren't already stamped to any tuning session.
  .get("/api/experiments/:id/importable-laps",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const importable = await getImportableLapsForExperiment(
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

  // POST /api/experiments/:id/import-laps — stamp a batch of history laps
  // onto this session (and optionally a specific branch/test), attaching them
  // to the aggregate the same way live-collected laps are. Posts a canned
  // chat ack so the agent picks the newly attached laps up on reload.
  .post("/api/experiments/:id/import-laps",
    zValidator("param", IdParamSchema),
    zValidator("json", ImportLapsSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const body = c.req.valid("json");

      if (session.gameId !== "f1-2025") {
        if (body.experimentVersionId != null) {
          const test = await getExperimentVersion(body.experimentVersionId);
          if (!test || test.experimentId !== id) {
            return c.json({ error: "Tuning test not found in this session" }, 404);
          }
        }

        const importedIds = await importLapsToExperiment(
          id,
          body.lapIds,
          body.experimentVersionId ?? null
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
                body.experimentVersionId != null ? " into the selected version" : " into the session baseline"
              }.`,
            },
          ]);
        } catch (err: any) {
          console.error("[tune] Failed to post import-laps note:", err?.message);
        }

        return c.json({ importedIds }, 201);
      }

      // F1: auto-sort laps into setups by fingerprint — body.experimentVersionId is
      // ignored, each lap's own carSetup decides where it lands.
      const existingTests = await listExperimentVersions(id);
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

      // group key: versionId (existing/newly-created) or null for baseline
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
            const newTestId = await createExperimentVersion({
              experimentId: id,
              version,
              label,
              parentVersionId: null,
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
        const ids = await importLapsToExperiment(id, groupLapIds, targetTestId);
        importedIds.push(...ids);
        if (ids.length > bestGroupCount) {
          bestGroupCount = ids.length;
          bestGroupTestId = targetTestId;
        }
      }

      if (session.headVersionId == null && bestGroupTestId != null && bestGroupCount > 0) {
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
  );

export const experimentLapAnalysisRoutes = new Hono()
  // GET /api/experiments/:id/lap-metrics — per-lap fuel/tyre metrics for the
  // laps this session owns (plan §2, Phase C). Derived server-side from each
  // lap's raw telemetry frames; returns a compact per-lap summary, not frame
  // dumps. Legacy laps with no stored telemetry omit their metric (never 0).
  // Tyre wear is the worst-tyre % worn at lap end, derived from the game's per-
  // tyre wear channel (see server/lap-analysis/metrics.ts); omitted when absent.
  .get("/api/experiments/:id/lap-metrics",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      // Same lap pool the workspace uses: laps explicitly linked to this tuning
      // session (migration v25), independent of race sessionId.
      const sessionLaps = await getLapsForExperiment(id);

      // Batch-decode the cache-miss laps in one pass; the DB-cached fast path
      // (migration v32) needs no frame decode.
      const missIds = sessionLaps
        .filter((l) => l.fuelPerLap == null && l.tyreWear == null)
        .map((l) => l.id);
      const missLaps = missIds.length > 0 ? await getLapsByIds(missIds) : [];
      const missById = new Map(missLaps.map((l) => [l.id, l]));

      const metrics: LapMetric[] = [];
      for (const lapMeta of sessionLaps) {
        // Cached path (migration v32): if either metric is already stored on the
        // lap row, the derivation has run — serve the columns, no frame decode.
        if (lapMeta.fuelPerLap != null || lapMeta.tyreWear != null) {
          const cached: LapMetric = { lapId: lapMeta.id };
          if (lapMeta.fuelPerLap != null) cached.fuelPerLap = lapMeta.fuelPerLap;
          if (lapMeta.tyreWear != null) cached.tyreWear = lapMeta.tyreWear;
          metrics.push(cached);
          continue;
        }

        // Miss: derive from the batch-decoded telemetry and persist onto the lap
        // so this is the last time this lap pays the decode cost.
        const lap = missById.get(lapMeta.id);
        const fuelPerLap = lap ? deriveFuelPerLap(lap.telemetry) : undefined;
        const tyreWear = lap ? deriveTyreWear(lap.telemetry) : undefined;
        if (lap) await setLapMetrics(lapMeta.id, fuelPerLap ?? null, tyreWear ?? null);
        const entry: LapMetric = { lapId: lapMeta.id };
        if (fuelPerLap != null) entry.fuelPerLap = fuelPerLap;
        if (tyreWear != null) entry.tyreWear = tyreWear;
        metrics.push(entry);
      }
      return c.json(metrics);
    }
  )

  // GET /api/experiments/:id/line-spread — trimmed (p90-p10) racing-line
  // spread trace over the session's clean lap pool, for the Track Focus
  // Consistency tab's line-spread lane + track-map heat overlay. Same
  // clean-lap selection as the Setup Engineer's evidence bundle
  // (selectCleanLaps: valid, not user-excluded, blunder-trimmed), session-wide
  // (not test/branch-scoped) to match /lap-metrics above.
  .get("/api/experiments/:id/line-spread",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      // The review page is driven by the lap ids in its URL and survives a
      // missing/orphaned session row (the core panels re-read laps directly),
      // so this lane must too: proceed on the lap pool alone, using the session
      // row only for corner metadata when present. Never 404 — return the empty
      // trace so the client shows its "need 3+ laps" state, not an error.
      const session = await getExperiment(id);

      const pool = await getLapsForExperiment(id);
      const { clean: allClean } = selectCleanLaps(pool);
      // Curate to the fastest N clean laps — bounds decode memory + compute on
      // long tracks (see shared/review-laps). Matches the client's curated
      // trace set so the consistency lane + map overlay agree.
      const clean = fastestLaps(allClean);

      // Cache hit: the trace is deterministic per (session, clean-lap set), so a
      // reopen with the same laps skips the whole decode + compute. The hash is
      // built from lap metadata alone (no frame decode).
      const lapSetHash = lineSpreadLapSetHash(clean.map((m) => m.id));
      const cached = await getLineSpreadCache(id, lapSetHash);
      if (cached) {
        c.header("Content-Type", "application/json");
        return c.body(cached);
      }

      // Single-pass batch decode of the clean pool (one warm-up + one parser
      // walk per session file) instead of a per-lap re-warming loop.
      const byId = new Map(clean.map((m) => [m.id, m]));
      const loaded = await getLapsByIds(clean.map((m) => m.id));
      const loadedLaps: { meta: LapMeta; telemetry: TelemetryPacket[] }[] = [];
      for (const lap of loaded) {
        const meta = byId.get(lap.id);
        if (!meta || lap.telemetry.length < 30) continue;
        loadedLaps.push({ meta, telemetry: lap.telemetry });
      }

      if (loadedLaps.length < 3) {
        return c.json({ fracs: [], spreadM: [], perCorner: [], lowTrust: false, consistencyScore: 0, overallSpreadM: 0, lapCount: loadedLaps.length, lapLines: [] });
      }

      const fastest = [...loadedLaps].sort((a, b) => a.meta.lapTime - b.meta.lapTime)[0]!;
      let corners = session?.trackOrdinal != null && session.gameId
        ? await getCorners(session.trackOrdinal, session.gameId as GameId)
        : [];
      if (corners.length === 0) corners = detectCorners(fastest.telemetry);

      const trace = computeLineSpreadTrace(loadedLaps.map((l) => l.telemetry), loadedLaps.map((l) => l.meta.id), corners);
      if (!trace) {
        return c.json({ fracs: [], spreadM: [], perCorner: [], lowTrust: false, consistencyScore: 0, overallSpreadM: 0, lapCount: loadedLaps.length, lapLines: [] });
      }
      // Store for next open (fire-and-forget correctness: recompute is safe).
      await setLineSpreadCache(id, lapSetHash, JSON.stringify(trace));
      return c.json(trace);
    }
  );
