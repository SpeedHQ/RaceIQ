import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { KNOWN_GAME_IDS } from "../../../shared/types";
import { getGame } from "../../../shared/games/registry";
import { getLapsForSession } from "../../db/lap-reprocessing-queries";
import { getTuneById as getDbTune } from "../../db/tune-queries";
import { buildLapsZip, lapsZipFilename, importLapsZip } from "../../zip";
import { importSessionBin, detectGameIdFromBuffer } from "../../session-capture/import-capture";
import { cancelStagedIbt, commitStagedIbt, IbtImportError, stageIbtUpload } from "../../import-ibt";
import { importMotec, resolveMotecTarget } from "../../motec/import";
import { getMotecTargets, initMotecTargets } from "../../motec/targets";
import { ExportZipQuerySchema, IbtImportTokenSchema } from "./support";

export const transferRoutes = new Hono()
  .get("/api/laps/export-zip", zValidator("query", ExportZipQuerySchema), async (c) => {
    const { ids, sessionIds } = c.req.valid("query");

    const lapIds = new Set<number>(ids ?? []);
    for (const sessionId of sessionIds ?? []) {
      for (const lap of await getLapsForSession(sessionId)) lapIds.add(lap.id);
    }
    if (lapIds.size === 0) return c.json({ error: "No laps matched the requested ids" }, 404);

    let built: Awaited<ReturnType<typeof buildLapsZip>>;
    try {
      built = await buildLapsZip([...lapIds]);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    const { bytes, manifest } = built;
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${lapsZipFilename(manifest)}"`);
    c.header("Content-Length", String(bytes.byteLength));
    return c.body(bytes.slice().buffer as ArrayBuffer);
  })

  .post("/api/laps/import-zip", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing 'file' in multipart body" }, 400);
    if (!(file.name || "").toLowerCase().endsWith(".zip")) {
      return c.json({ error: "Expected a .zip file" }, 400);
    }

    try {
      const result = await importLapsZip(new Uint8Array(await file.arrayBuffer()));
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Failed to import zip: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
  })

  .post("/api/laps/import", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing 'file' in multipart body" }, 400);

    const uploadName = file.name || "upload.bin";
    const lower = uploadName.toLowerCase();
    if (!lower.endsWith(".bin") && !lower.endsWith(".bin.gz")) {
      return c.json({ error: "Expected a .bin or .bin.gz file" }, 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const gameId = detectGameIdFromBuffer(bytes);
    if (!gameId) {
      return c.json(
        { error: `Could not detect game from "${uploadName}" — no recognized frame format found. Supported games: ${KNOWN_GAME_IDS.join(", ")}.` },
        400
      );
    }

    try {
      const { packetCount, laps } = await importSessionBin(bytes, gameId);
      if (packetCount === 0) return c.json({ error: "No telemetry packets found in file" }, 400);
      return c.json({
        ok: true,
        gameId,
        routePrefix: getGame(gameId).routePrefix,
        packetCount,
        imported: laps.length,
        laps,
      });
    } catch (err: any) {
      console.error("[Import] Failed:", err?.message);
      return c.json({ error: "Failed to import file", details: String(err?.message ?? err) }, 500);
    }
  })

  .get("/api/motec/targets", (c) => {
    initMotecTargets();
    return c.json(
      getMotecTargets().map((t) => ({
        gameId: t.gameId,
        displayName: t.displayName,
        routePrefix: t.routePrefix,
        carsEndpoint: t.carsEndpoint,
        limitations: t.limitations,
      })),
    );
  })

  .post("/api/laps/import-motec", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing 'file' in multipart body" }, 400);
    if (!file.name.toLowerCase().endsWith(".ld")) {
      return c.json({ error: "Expected a MoTeC .ld file" }, 400);
    }

    // The sidecar carries the lap beacons. Without it the log imports as a
    // single unsplit stint, which is correct for a standalone hotlap export.
    const sidecar = form?.get("ldx");
    const ldxText = sidecar instanceof File ? await sidecar.text() : undefined;

    // Car and track are the user's call, not the log header's — a log filed
    // against the wrong track gets meaningless sectors and corner names. The
    // setup is optional: not knowing it costs a label, nothing more.
    const num = (key: string): number | undefined => {
      const raw = form?.get(key);
      if (typeof raw !== "string" || raw.trim() === "") return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const carOrdinal = num("carOrdinal");
    const trackOrdinal = num("trackOrdinal");
    if (carOrdinal === undefined || trackOrdinal === undefined) {
      return c.json({ error: "carOrdinal and trackOrdinal are required" }, 400);
    }

    // Which sim exported the log. Resolved up front so an unsupported game is a
    // 400 naming the problem, not a 500 from deep inside the transcoder — and
    // so the ordinals above are read against the right game's roster.
    const gameIdRaw = form?.get("gameId");
    let target;
    try {
      target = resolveMotecTarget(typeof gameIdRaw === "string" && gameIdRaw ? gameIdRaw : undefined);
    } catch (err: any) {
      return c.json({ error: String(err?.message ?? err) }, 400);
    }

    // laps.tune_id is a real FK, so an id that doesn't exist would surface as a
    // constraint failure and a 500. It's user input; say so plainly instead.
    const tuneId = num("tuneId");
    if (tuneId !== undefined) {
      if (!(await getDbTune(tuneId))) {
        return c.json({ error: `No setup with id ${tuneId}` }, 400);
      }
    }

    try {
      const result = await importMotec(Buffer.from(await file.arrayBuffer()), ldxText, {
        gameId: target.gameId,
        carOrdinal,
        trackOrdinal,
        tuneId,
      });
      if (result.laps.length === 0) {
        return c.json(
          { error: "No laps could be detected in this log", meta: result.meta, limitations: result.limitations },
          400
        );
      }
      return c.json({
        ...result,
        ok: true,
        gameId: target.gameId,
        routePrefix: target.routePrefix,
        imported: result.laps.length,
      });
    } catch (err: any) {
      console.error("[MoTeC Import] Failed:", err?.message);
      return c.json({ error: "Failed to import MoTeC log", details: String(err?.message ?? err) }, 500);
    }
  })

  .post("/api/laps/import-ibt/preview", async (c) => {
    const uploadName =
      c.req.header("x-file-name") ?? "session.ibt";
    if (!uploadName.toLowerCase().endsWith(".ibt")) {
      return c.json({ error: "Expected an .ibt file" }, 400);
    }
    const declaredHeader =
      c.req.header("x-file-size") ?? c.req.header("content-length");
    const declaredBytes = declaredHeader
      ? Number(declaredHeader)
      : undefined;

    try {
      const result = await stageIbtUpload(
        c.req.raw.body,
        uploadName,
        declaredBytes,
      );
      return c.json(result);
    } catch (error) {
      const status =
        error instanceof IbtImportError ? error.status : 400;
      const message =
        error instanceof Error ? error.message : String(error);
      console.error("[IBT Import] Preview failed:", message);
      return c.json(
        { error: `Failed to preview IBT: ${message}` },
        status,
      );
    }
  })

  .post(
    "/api/laps/import-ibt/commit",
    zValidator("json", IbtImportTokenSchema),
    async (c) => {
      const { token } = c.req.valid("json");
      try {
        const { packetCount, laps, preview } =
          await commitStagedIbt(token);
        return c.json({
          ok: true,
          gameId: "iracing" as const,
          routePrefix: getGame("iracing").routePrefix,
          packetCount,
          imported: laps.length,
          laps,
          preview,
        });
      } catch (error) {
        const status =
          error instanceof IbtImportError ? error.status : 500;
        const message =
          error instanceof Error ? error.message : String(error);
        console.error("[IBT Import] Commit failed:", message);
        return c.json(
          { error: `Failed to import IBT: ${message}` },
          status,
        );
      }
    },
  )

  .post(
    "/api/laps/import-ibt/cancel",
    zValidator("json", IbtImportTokenSchema),
    (c) => {
      const { token } = c.req.valid("json");
      cancelStagedIbt(token);
      return c.json({ ok: true });
    },
  );
