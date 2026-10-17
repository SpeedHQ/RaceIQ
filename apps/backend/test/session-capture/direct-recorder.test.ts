import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { encodeFrameLength, encodeParserBootstrapFrame, iterateSessionCaptureRecords, iterateSessionFrames, META_FRAME_BYTES } from "@raceiq/capture-formats/session/framing";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { parsePacket, subscribeParserSource, type ParserReplayLocator } from "@raceiq/backend-core/games/packet-dispatch";
import type { DetectorOwnershipTransition, DetectorOwnershipWindow } from "@raceiq/telemetry-core/processor/ordinal-engine";
import { DirectCaptureRecording } from "@raceiq/backend-core/session-capture/direct-recorder";
import { initServerGameAdapters } from "../../src/games/init";
import { eq } from "drizzle-orm";

const captures: DirectCaptureRecording[] = [];
const directories: string[] = [];
const sessionIds: number[] = [];
afterEach(async () => {
  await Promise.all(captures.splice(0).map((capture) => capture.stop().catch(() => {})));
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixtureFrames(): Buffer[] {
  const fixture = gunzipSync(readFileSync(join(ROOT_DIR, "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz")));
  return [...iterateSessionFrames(fixture)].slice(0, 4);
}

function ownershipTransition(kind: DetectorOwnershipTransition["kind"], window: DetectorOwnershipWindow): DetectorOwnershipTransition {
  return { revision: window.revision, kind, window, state: { revision: window.revision, watermarkOffset: null, nextWindowStartOffset: null, windows: [] } };
}

describe("DirectCaptureRecording", () => {
  it("conserves raw parser-primer and native frames at native-wire source coordinates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raceiq-direct-capture-"));
    directories.push(directory);
    const capture = new DirectCaptureRecording("fm-2023", directory, join(directory, "capture-manifest.json"), { writerOptions: { maxBatchDelayMs: 0 } });
    captures.push(capture);
    await capture.ready;
    expect(capture.standbyReady).toBe(true);

    const [primerFrame, nativeFrame] = fixtureFrames();
    expect(primerFrame).toBeDefined(); expect(nativeFrame).toBeDefined();
    const bootstrap = encodeParserBootstrapFrame("fm-2023", new Uint8Array());
    const primer = Buffer.concat([encodeFrameLength(primerFrame!.length, 100), primerFrame!]);
    const parserPrefix = Buffer.concat([bootstrap, primer]);
    capture.writeRawCaptureBytes(parserPrefix);
    capture.writeRecord(nativeFrame!, 110);
    const expectedSourceBytes = META_FRAME_BYTES + parserPrefix.length + encodeFrameLength(nativeFrame!.length, 110).length + nativeFrame!.length;
    expect(capture.sourceBytes).toBe(expectedSourceBytes);
    expect(capture.sourceRecordCount).toBe(3);

    await capture.stop();
    const manifest = JSON.parse(await readFile(join(directory, "capture-manifest.json"), "utf8"));
    expect(manifest.sourceCoordinates).toBe("native-wire-v1");
    expect(manifest.sourceByteLength).toBe(expectedSourceBytes);
    expect(manifest.sourceRecordCount).toBe(3);
    const chunk = manifest.chunks[0]!;
    expect(chunk.sourceRecordByteOffset).toBe(META_FRAME_BYTES + 16);
    expect(chunk.parserBootstrapHash).toBe(createHash("sha256").update(new Uint8Array()).digest("hex"));
    expect(chunk.recordCount).toBe(3);
    const artifact = await readFile(join(directory, chunk.path));
    const recovered = [...iterateSessionCaptureRecords(artifact)].filter((record) => record.kind === "frame");
    expect(recovered.map((record) => record.frame)).toEqual([primerFrame, nativeFrame]);
    expect(recovered.map((record) => record.frameTimeMs)).toEqual([100, 110]);
    expect(capture.isSealed).toBe(true);
  });

  it("publishes delayed binding after close and reconstructs shared lap boundary once", async () => {
    initServerGameAdapters();
    const directory = await mkdtemp(join(tmpdir(), "raceiq-direct-boundary-"));
    directories.push(directory);
    const frames = fixtureFrames();
    const [lapAFrame, boundaryFrame] = frames;
    expect(lapAFrame).toBeDefined(); expect(boundaryFrame).toBeDefined();
    let locator: ParserReplayLocator | null = null;
    const unsubscribe = subscribeParserSource((input) => { if (input.frame === boundaryFrame) locator = input.locator; });
    for (const frame of frames) parsePacket(frame!, 100 + frames.indexOf(frame!));
    unsubscribe();
    expect(locator).not.toBeNull();

    const session = await db.insert(sessions).values({ gameId: "fm-2023", carId: "test-car", trackId: "test-track", rawFile: null }).returning({ id: sessions.id }).get();
    if (!session) throw new Error("Failed creating direct-recorder session fixture");
    sessionIds.push(session.id);
    const offsetA = META_FRAME_BYTES;
    const offsetB = offsetA + encodeFrameLength(lapAFrame!.length, 100).length + lapAFrame!.length;
    const rowA = await db.insert(laps).values({ sessionId: session.id, lapNumber: 1, lapTime: 60, isValid: true, rawByteOffset: offsetA, rawFrameCount: 1 }).returning({ id: laps.id }).get();
    const rowB = await db.insert(laps).values({ sessionId: session.id, lapNumber: 2, lapTime: 61, isValid: true, rawByteOffset: offsetB, rawFrameCount: 1 }).returning({ id: laps.id }).get();
    if (!rowA || !rowB) throw new Error("Failed creating direct-recorder lap fixtures");

    let closedA!: () => void;
    const durableCloseA = new Promise<void>((resolve) => { closedA = resolve; });
    const capture = new DirectCaptureRecording("fm-2023", directory, join(directory, "capture-manifest.json"), {
      writerOptions: { maxBatchDelayMs: 0, onClosed: () => closedA() },
    });
    captures.push(capture);
    await capture.ready;
    capture.attachSession(session.id, Promise.resolve(), () => {});
    capture.writeRecord(lapAFrame!, 100);
    const windowA: DetectorOwnershipWindow = { revision: 1, lapNumber: 1, startOffset: offsetA, startOrdinal: 0, frameCount: 1, status: "provisional", trailingContextFrameCount: 0, bounded: true };
    capture.processTransitions([ownershipTransition("window-start", windowA)], null);
    capture.writeRecord(boundaryFrame!, 101);
    const windowAFinal: DetectorOwnershipWindow = { ...windowA, revision: 2, status: "final", trailingContextFrameCount: 1 };
    const windowB: DetectorOwnershipWindow = { revision: 3, lapNumber: 2, startOffset: offsetB, startOrdinal: 1, frameCount: 1, status: "provisional", trailingContextFrameCount: 0, bounded: true };
    capture.processTransitions([ownershipTransition("window-finalized", windowAFinal), ownershipTransition("window-start", windowB)], locator);
    await durableCloseA;
    capture.bindLap({ sessionId: session.id, lapId: rowA.id, lapNumber: 1, startByteOffset: offsetA, frameCount: 1 });
    capture.processTransitions([ownershipTransition("final-incomplete", { ...windowB, revision: 4, status: "incomplete" })], null);
    capture.bindLap({ sessionId: session.id, lapId: rowB.id, lapNumber: 2, startByteOffset: offsetB, frameCount: 1 });
    await capture.stop();

    const manifest = JSON.parse(await readFile(join(directory, "capture-manifest.json"), "utf8"));
    expect(manifest.sourceRecordCount).toBe(2);
    const lapChunks = manifest.chunks.filter((chunk: { kind: string }) => chunk.kind === "lap");
    expect(lapChunks).toHaveLength(2);
    const [chunkA, chunkB] = lapChunks;
    expect(chunkA).toMatchObject({ lapId: String(rowA.id), recordCount: 1, ownedFrameCount: 1, trailingContextFrameCount: 1 });
    expect(chunkB).toMatchObject({ lapId: String(rowB.id), recordCount: 1, ownedFrameCount: 1 });
    expect(chunkB.sourceRecordByteOffset).toBe(chunkB.ownedFrameByteOffset);
    const bytesA = await readFile(join(directory, chunkA.path));
    const bytesB = await readFile(join(directory, chunkB.path));
    const recordsA = [...iterateSessionCaptureRecords(bytesA)].filter((record) => record.kind === "frame");
    const recordsB = [...iterateSessionCaptureRecords(bytesB, chunkB.sourceRecordByteOffset, { strict: true })].filter((record) => record.kind === "frame");
    expect(recordsA.at(-1)?.frame).toEqual(recordsB[0]?.frame);
    expect(recordsB[0]?.frame).toEqual(boundaryFrame);
    const publishedLaps = await db.select({ captureChunkId: laps.captureChunkId, sourceFrameStart: laps.sourceFrameStart, sourceFrameCount: laps.sourceFrameCount }).from(laps).where(eq(laps.sessionId, session.id)).all();
    expect(publishedLaps).toHaveLength(2);
    expect(publishedLaps.every((lap) => lap.captureChunkId !== null && lap.sourceFrameCount === 1)).toBe(true);
    expect(publishedLaps.map((lap) => lap.sourceFrameStart)).toEqual([0, 1]);
  });
  it("promotes a previously announced boundary without rotating or losing later native frames", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raceiq-direct-promotion-"));
    directories.push(directory);
    const capture = new DirectCaptureRecording("fm-2023", directory, join(directory, "capture-manifest.json"));
    captures.push(capture);
    await capture.ready;
    const frames = fixtureFrames().slice(0, 2);
    capture.writeRecord(frames[0]!, 100);
    const window: DetectorOwnershipWindow = {
      revision: 1, lapNumber: 1, startOffset: META_FRAME_BYTES, startOrdinal: 0,
      frameCount: 1, status: "provisional", trailingContextFrameCount: 0, bounded: true,
    };
    capture.processTransitions([ownershipTransition("window-start", window)], null);
    capture.writeRecord(frames[1]!, 101);
    capture.processTransitions([ownershipTransition("window-start", { ...window, revision: 2 })], null);
    capture.processTransitions([ownershipTransition("window-abandoned", { ...window, revision: 3, frameCount: 2 })], null);
    await capture.stop();
    const manifest = JSON.parse(await readFile(join(directory, "capture-manifest.json"), "utf8"));
    expect(manifest.chunks).toHaveLength(1);
    const artifact = await readFile(join(directory, manifest.chunks[0].path));
    const recorded = [...iterateSessionCaptureRecords(artifact)].filter(record => record.kind === "frame");
    expect(recorded.map(record => record.frame)).toEqual(frames);
    expect(recorded.map(record => record.frameTimeMs)).toEqual([100, 101]);
    expect(manifest.chunks[0].recordCount).toBe(2);
  });
  it("keeps rejected preparation candidate frames in the continuing auxiliary source", async () => {
    initServerGameAdapters();
    const directory = await mkdtemp(join(tmpdir(), "raceiq-direct-candidate-"));
    directories.push(directory);
    const frames = fixtureFrames();
    let locator: ParserReplayLocator | null = null;
    const unsubscribe = subscribeParserSource(input => { if (input.frame === frames[0]) locator = input.locator; });
    parsePacket(frames[0]!, 100);
    unsubscribe();
    const capture = new DirectCaptureRecording("fm-2023", directory, join(directory, "capture-manifest.json"));
    captures.push(capture);
    await capture.ready;
    capture.writeRecord(frames[0]!, 100);
    const candidate: DetectorOwnershipWindow = {
      revision: 1, lapNumber: 2, startOffset: META_FRAME_BYTES, startOrdinal: 0,
      frameCount: 0, status: "provisional", trailingContextFrameCount: 0, bounded: true,
      preparationOnly: true, holdForResolution: true,
    };
    capture.processTransitions([ownershipTransition("candidate-start", candidate)], locator);
    capture.writeRecord(frames[1]!, 101);
    capture.processTransitions([ownershipTransition("window-abandoned", { ...candidate, revision: 2, frameCount: 1 })], null);
    await capture.stop();
    const manifest = JSON.parse(await readFile(join(directory, "capture-manifest.json"), "utf8"));
    expect(manifest.sourceRecordCount).toBe(2);
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.chunks[0]).toMatchObject({ kind: "auxiliary", recordCount: 2 });
    const framesBySource = [];
    for (const chunk of manifest.chunks) {
      const artifact = await readFile(join(directory, chunk.path));
      const records = [...iterateSessionCaptureRecords(artifact, chunk.sourceRecordByteOffset, { strict: true })]
        .filter(record => record.kind === "frame").slice(0, chunk.recordCount);
      framesBySource.push(...records.map(record => record.frame));
    }
    expect(framesBySource).toEqual(frames.slice(0, 2));
  });
  it("promotes retained candidate suffix at its original ordinal", async () => {
    initServerGameAdapters();
    const directory = await mkdtemp(join(tmpdir(), "raceiq-direct-promotion-"));
    directories.push(directory);
    const frames = fixtureFrames();
    let locator: ParserReplayLocator | null = null;
    const unsubscribe = subscribeParserSource(input => { if (input.frame === frames[0]) locator = input.locator; });
    parsePacket(frames[0]!, 100);
    unsubscribe();
    const capture = new DirectCaptureRecording("fm-2023", directory, join(directory, "capture-manifest.json"));
    captures.push(capture);
    await capture.ready;
    capture.writeRecord(frames[0]!, 100);
    const candidate: DetectorOwnershipWindow = {
      revision: 1, lapNumber: 2, startOffset: META_FRAME_BYTES, startOrdinal: 0,
      frameCount: 0, status: "provisional", trailingContextFrameCount: 0, bounded: true,
      preparationOnly: true, holdForResolution: true,
    };
    capture.processTransitions([ownershipTransition("candidate-start", candidate)], locator);
    capture.writeRecord(frames[1]!, 101);
    capture.writeRecord(frames[2]!, 102);
    const promoted = { ...candidate, revision: 2, frameCount: 3, preparationOnly: undefined, holdForResolution: undefined };
    capture.processTransitions([ownershipTransition("window-start", promoted)], null);
    capture.processTransitions([ownershipTransition("window-abandoned", { ...promoted, revision: 3 })], null);
    await capture.stop();
    const manifest = JSON.parse(await readFile(join(directory, "capture-manifest.json"), "utf8"));
    expect(manifest.sourceRecordCount).toBe(3);
    expect(manifest.chunks.reduce((count: number, chunk: { recordCount: number }) => count + chunk.recordCount, 0)).toBe(3);
    expect(manifest.chunks.map((chunk: { kind: string }) => chunk.kind)).toEqual(["auxiliary", "auxiliary"]);
    const framesBySource = [];
    for (const chunk of manifest.chunks) {
      const artifact = await readFile(join(directory, chunk.path));
      const records = [...iterateSessionCaptureRecords(artifact, chunk.sourceRecordByteOffset, { strict: true })]
        .filter(record => record.kind === "frame").slice(0, chunk.recordCount);
      framesBySource.push(...records.map(record => record.frame));
    }
    expect(framesBySource).toEqual(frames.slice(0, 3));
  });
});
