import { Hono } from "hono";
import { readRecordedTelemetry } from "../../session-capture/replay-packets";
import type {
  LiveTelemetryFrameMessageV1,
  LiveTelemetrySchemaMessageV1,
} from "../../../shared/telemetry/live/contracts";
import { LiveTelemetryProjector } from "../../telemetry/live-projector";
import {
  type KunosRecordingFrame,
  type Point2D,
  type Point3D,
  generateTrackSVG,
  listE2eRecordings,
  parseAccRecordingLaps,
  parseAccRecordingPacketsWithSpeed,
  parseAccRecordingPoints,
  parseUdpRecordingLaps,
  parseUdpRecordingPacketsWithSpeed,
  parseUdpRecordingPoints,
  readAccRecordingFrames,
  resolveRecordingGameId,
  resolveRecordingPath,
} from "./recording-support";

export const recordingRoutes = new Hono();

recordingRoutes.get("/api/dev/e2e-files", (c) => {
  try {
    return c.json({ files: listE2eRecordings() });
  } catch (e) {
    return c.json(
      { error: "Failed to list E2E files", details: String(e) },
      500
    );
  }
});

recordingRoutes.get("/api/dev/e2e-svg/:recordingName", (c) => {
  try {
    const recordingName = c.req.param("recordingName");
    const recordingPath = resolveRecordingPath(recordingName);

    if (!recordingPath.ok) {
      return c.json({ error: recordingPath.error }, recordingPath.status);
    }

    try {
      const gameId = resolveRecordingGameId(recordingName);
      if (!gameId) {
        return c.json({ error: "Could not determine recording game" }, 400);
      }
      let packets: Point2D[];

      if (gameId === "acc") {
        let frames: KunosRecordingFrame[];
        try {
          frames = readAccRecordingFrames(recordingPath.path);
        } catch (e) {
          console.error("Failed to read ACC frames:", e);
          return c.json(
            { error: "Failed to read ACC frames", details: String(e) },
            400
          );
        }
        packets = parseAccRecordingPoints(frames);
      } else {
        packets = parseUdpRecordingPoints(gameId, recordingPath.path);
      }

      if (packets.length === 0) {
        return c.json(
          { error: "Failed to parse any packets from recording" },
          400
        );
      }

      return c.html(generateTrackSVG(packets));
    } catch (e) {
      console.error("Failed to parse recording:", e);
      return c.json(
        { error: "Failed to generate SVG", details: String(e) },
        500
      );
    }
  } catch (e) {
    return c.json(
      { error: "Failed to read recording", details: String(e) },
      404
    );
  }
});

recordingRoutes.get("/api/dev/e2e-laps/:recordingName", async (c) => {
  try {
    const recordingName = c.req.param("recordingName");
    const recordingPath = resolveRecordingPath(recordingName);

    if (!recordingPath.ok) {
      return c.json({ error: recordingPath.error }, recordingPath.status);
    }

    try {
      const gameId = resolveRecordingGameId(recordingName);
      if (!gameId) {
        return c.json({ error: "Could not determine recording game" }, 400);
      }

      if (gameId === "acc") {
        let frames: KunosRecordingFrame[];
        try {
          frames = readAccRecordingFrames(recordingPath.path);
        } catch (e) {
          console.error("Failed to read ACC frames:", e);
          return c.json({
            laps: [],
            totalPackets: 0,
          });
        }
        return c.json(parseAccRecordingLaps(frames));
      }

      return c.json(parseUdpRecordingLaps(gameId, recordingPath.path));
    } catch (e) {
      console.error("Failed to detect laps:", e);
      return c.json(
        { error: "Failed to detect laps", details: String(e) },
        500
      );
    }
  } catch (e) {
    return c.json(
      { error: "Failed to process recording", details: String(e) },
      404
    );
  }
});

export const recordingPacketRoutes = new Hono();

recordingPacketRoutes.get("/api/dev/e2e-packets/:recordingName", (c) => {
  try {
    const recordingName = c.req.param("recordingName");
    const recordingPath = resolveRecordingPath(recordingName);

    if (!recordingPath.ok) {
      return c.json({ error: recordingPath.error }, recordingPath.status);
    }

    try {
      const gameId = resolveRecordingGameId(recordingName);
      if (!gameId) {
        return c.json({ error: "Could not determine recording game" }, 400);
      }
      let packets: Point3D[];

      if (gameId === "acc") {
        let frames: KunosRecordingFrame[];
        try {
          frames = readAccRecordingFrames(recordingPath.path);
          console.log(`[E2E] Loaded ${frames.length} frames from ${recordingPath.path}`);
        } catch (e) {
          console.error("Failed to read ACC frames:", e);
          return c.json({
            packetCount: 0,
            packets: [],
          });
        }
        packets = parseAccRecordingPacketsWithSpeed(frames);
      } else {
        packets = parseUdpRecordingPacketsWithSpeed(gameId, recordingPath.path);
      }

      return c.json({
        packetCount: packets.length,
        packets,
      });
    } catch (e) {
      console.error("Failed to parse recording:", e);
      return c.json({
        packetCount: 0,
        packets: [],
      });
    }
  } catch (e) {
    return c.json(
      { error: "Failed to read packets", details: String(e) },
      404
    );
  }
});

/**
 * GET /api/dev/e2e-telemetry/:recordingName
 * Parse a .bin recording and resolve every packet through the same semantic
 * pipeline that serves live telemetry (`LiveTelemetryProjector`), so recorded
 * gearing cannot disagree with live behavior. Returns the live-wire schema
 * plus one frame per packet; the client rebuilds `LiveTelemetryView`s with
 * the live decoder. Richer than e2e-packets (position+speed only).
 */
recordingPacketRoutes.get("/api/dev/e2e-telemetry/:recordingName", (c) => {
  try {
    const recordingName = c.req.param("recordingName");
    const recordingPath = resolveRecordingPath(recordingName);

    if (!recordingPath.ok) {
      return c.json({ error: recordingPath.error }, recordingPath.status);
    }

    try {
      const gameId = resolveRecordingGameId(recordingName);
      if (!gameId) {
        return c.json({ error: "Could not determine recording game" }, 400);
      }

      const packets = readRecordedTelemetry(gameId, recordingPath.path).packets;
      const projector = new LiveTelemetryProjector();
      let schema: LiveTelemetrySchemaMessageV1 | null = null;
      const frames: LiveTelemetryFrameMessageV1[] = [];
      for (let i = 0; i < packets.length; i++) {
        const packet = packets[i]!;
        const receivedAtMs = Number.isFinite(packet.TimestampMS)
          ? packet.TimestampMS
          : i;
        const projection = projector.project({ packet, receivedAtMs });
        if (projection.schema) schema = projection.schema;
        if (projection.frame) frames.push(projection.frame);
      }

      return c.json({ packetCount: packets.length, schema, frames });
    } catch (e) {
      console.error("Failed to parse recording:", e);
      return c.json({ packetCount: 0, schema: null, frames: [] });
    }
  } catch (e) {
    return c.json(
      { error: "Failed to read telemetry", details: String(e) },
      404,
    );
  }
});
