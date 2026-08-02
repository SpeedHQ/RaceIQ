import { Hono } from "hono";
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
        packets = parseUdpRecordingPoints(recordingPath.path);
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

      return c.json(parseUdpRecordingLaps(recordingPath.path));
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
        packets = parseUdpRecordingPacketsWithSpeed(recordingPath.path);
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
