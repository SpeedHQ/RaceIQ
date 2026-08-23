import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { KNOWN_GAME_IDS } from "../../../shared/games/ids";
import { getGame } from "../../../shared/games/registry";
import { getLapsForSession } from "../../db/lap-reprocessing-queries";
import { getTuneById as getDbTune } from "../../db/tune-queries";
import { buildLapsZip, lapsZipFilename, importLapsZip, detectLapsZip } from "../../laps/archive";
import { importSessionBin, detectGameIdFromBuffer } from "../../session-capture/import-capture";
import { cancelStagedIbt, commitStagedIbt, IbtImportError, stageIbtUpload } from "../../games/iracing/import-ibt";
import {
  importLMUDuckDB,
  isDuckDBFile,
  previewLMUDuckDB,
} from "../../games/lmu/import-duckdb";
import { importMotec, resolveMotecTarget } from "../../motec/import";
import { getMotecTargets, initMotecTargets } from "../../motec/targets";
import { ExportZipQuerySchema, IbtCommitSchema, IbtImportTokenSchema, OwnershipSchema } from "./support";

function temporaryDuckDBPath(): string {
  return resolve(
    tmpdir(),
    `raceiq-lmu-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`,
  );
}

function duckDBWalUpload(
  form: FormData | null,
  databaseName: string,
): { wal: File | null; error: string | null } {
  const entry = form?.get("wal");
  if (entry == null) return { wal: null, error: null };
  if (!(entry instanceof File)) {
    return { wal: null, error: "DuckDB WAL sidecar must be a file" };
  }
  const expectedName = `${databaseName}.wal`.toLowerCase();
  if (entry.name.toLowerCase() !== expectedName) {
    return {
      wal: null,
      error: `Expected matching WAL sidecar "${databaseName}.wal"`,
    };
  }
  return { wal: entry, error: null };
}

async function stageTemporaryDuckDB(
  path: string,
  bytes: Buffer,
  wal: File | null,
): Promise<void> {
  writeFileSync(path, bytes);
  if (wal) {
    writeFileSync(`${path}.wal`, Buffer.from(await wal.arrayBuffer()));
  }
}

function cleanupTemporaryDuckDB(path: string): void {
  for (const candidate of [path, `${path}.wal`]) {
    try {
      unlinkSync(candidate);
    } catch {}
  }
}

function duckDBErrorMessage(
  error: unknown,
  databaseName: string,
  hasWal: boolean,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!hasWal && /table with name metadata does not exist/i.test(message)) {
    return `Recording requires its matching "${databaseName}.wal" sidecar. Select both files together.`;
  }
  return message;
}

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

  .post("/api/laps/detect-import", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing 'file' in multipart body" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const lower = file.name.toLowerCase();
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      try {
        const detection = detectLapsZip(bytes);
        return c.json({
          format: "zip" as const,
          supported: detection.isRaceIqArchive,
          gameIds: detection.gameIds,
          captureCount: detection.captureCount,
          message: detection.isRaceIqArchive ? null : "ZIP does not contain RaceIQ session captures.",
        });
      } catch {
        return c.json({ format: "unknown" as const, supported: false, gameIds: [], captureCount: 0, message: "File is not a readable ZIP archive." });
      }
    }
    if (lower.endsWith(".bin") || lower.endsWith(".bin.gz")) {
      const gameId = detectGameIdFromBuffer(Buffer.from(bytes));
      return c.json({
        format: "bin" as const,
        supported: gameId != null,
        gameIds: gameId ? [gameId] : [],
        captureCount: 1,
        message: gameId ? null : "Could not detect a supported game from this capture.",
      });
    }
    if (lower.endsWith(".duckdb")) {
      const buffer = Buffer.from(bytes);
      if (!isDuckDBFile(buffer)) {
        return c.json({
          format: "duckdb" as const,
          supported: false,
          gameIds: [],
          captureCount: 0,
          message: "File is not a readable DuckDB database.",
        });
      }
      const walUpload = duckDBWalUpload(form, file.name);
      if (walUpload.error) {
        return c.json({ error: walUpload.error }, 400);
      }
      const path = temporaryDuckDBPath();
      try {
        await stageTemporaryDuckDB(path, buffer, walUpload.wal);
        const preview = await previewLMUDuckDB(path);
        const supported = preview.completedLapCount > 0;
        return c.json({
          format: "duckdb" as const,
          supported,
          gameIds: ["lmu"],
          captureCount: 1,
          message: supported
            ? null
            : "Recording contains no complete laps to import.",
          preview,
        });
      } catch (error) {
        return c.json({
          format: "duckdb" as const,
          supported: false,
          gameIds: [],
          captureCount: 0,
          message: duckDBErrorMessage(
            error,
            file.name,
            walUpload.wal !== null,
          ),
        });
      } finally {
        cleanupTemporaryDuckDB(path);
      }
    }
    if (lower.endsWith(".ibt")) return c.json({ format: "ibt" as const, supported: true, gameIds: ["iracing"], captureCount: 1, message: null });
    if (lower.endsWith(".ld")) return c.json({ format: "motec" as const, supported: true, gameIds: [], captureCount: 1, message: null });
    return c.json({ format: "unknown" as const, supported: false, gameIds: [], captureCount: 0, message: "Unsupported import file." });
  })
  .post("/api/laps/import-zip", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing 'file' in multipart body" }, 400);
    const ownership = OwnershipSchema.safeParse(form?.get("ownership"));
    if (!ownership.success) return c.json({ error: "ownership must be exactly mine or others" }, 400);
    if (!file.name.toLowerCase().endsWith(".zip")) return c.json({ error: "Expected a .zip file" }, 400);
    try {
      const result = await importLapsZip(new Uint8Array(await file.arrayBuffer()), { ownership: ownership.data });
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
    if (
      !lower.endsWith(".bin") &&
      !lower.endsWith(".bin.gz") &&
      !lower.endsWith(".duckdb")
    ) {
      return c.json({ error: "Expected a .bin, .bin.gz, or .duckdb file" }, 400);
    }
    const ownership = OwnershipSchema.safeParse(form?.get("ownership"));
    if (!ownership.success) return c.json({ error: "ownership must be exactly mine or others" }, 400);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (lower.endsWith(".duckdb")) {
      if (!isDuckDBFile(bytes)) {
        return c.json({ error: "File is not a readable DuckDB database" }, 400);
      }
      const walUpload = duckDBWalUpload(form, file.name);
      if (walUpload.error) {
        return c.json({ error: walUpload.error }, 400);
      }
      const path = temporaryDuckDBPath();
      try {
        await stageTemporaryDuckDB(path, bytes, walUpload.wal);
        const result = await importLMUDuckDB(path, ownership.data);
        return c.json({
          ok: true,
          gameId: "lmu" as const,
          routePrefix: getGame("lmu").routePrefix,
          packetCount: result.packetCount,
          imported: result.laps.length,
          laps: result.laps,
        });
      } catch (error) {
        const details = duckDBErrorMessage(
          error,
          file.name,
          walUpload.wal !== null,
        );
        console.error("[LMU Import] Failed:", details);
        return c.json(
          {
            error: "Failed to import LMU telemetry database",
            details,
          },
          400,
        );
      } finally {
        cleanupTemporaryDuckDB(path);
      }
    }
    const gameId = detectGameIdFromBuffer(bytes);
    if (!gameId) {
      return c.json(
        { error: `Could not detect game from "${uploadName}" — no recognized frame format found. Supported games: ${KNOWN_GAME_IDS.join(", ")}.` },
        400
      );
    }
    try {

      const { packetCount, laps } = await importSessionBin(bytes, gameId, { ownership: ownership.data });
      if (packetCount === 0) return c.json({ error: "No telemetry packets found in file" }, 400);
      return c.json({
        ok: true,
        gameId,
        routePrefix: getGame(gameId).routePrefix,
        packetCount,
        imported: laps.length,
        laps,
      });
    } catch (error) {
      console.error(
        "[Import] Failed:",
        error instanceof Error ? error.message : error,
      );
      return c.json({
        error: "Failed to import file",
        details: error instanceof Error ? error.message : String(error),
      }, 500);
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
    const ownership = OwnershipSchema.safeParse(form?.get("ownership"));
    const sidecar = form?.get("ldx");
    const ldxText = sidecar instanceof File ? await sidecar.text() : undefined;
    if (!ownership.success) return c.json({ error: "ownership must be exactly mine or others" }, 400);

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
    let target: ReturnType<typeof resolveMotecTarget>;
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
        ownership: ownership.data,
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
    zValidator("json", IbtCommitSchema),
    async (c) => {
      const { token, ownership } = c.req.valid("json");
      try {
        const { packetCount, laps, preview } =
          await commitStagedIbt(token, ownership);
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
