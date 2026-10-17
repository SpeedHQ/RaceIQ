import { and, eq, asc } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import { createIRacingSourceDecoderState, decodeIRacingSourceFrame } from "@raceiq/capture-formats/iracing/source-frame";
import { isPitCycleLap } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import { reduceIRacingIncidents, type IRacingIncidentInput, type IRacingIncidentLapInput } from "@raceiq/game-iracing/incident-report";
import type { IRacingIncidentCoverageReason, IRacingIncidentEvent, IRacingIncidentReport } from "@raceiq/shared/racing/sessions/iracing-incidents";

interface Window { lapId: number; offset: number; count: number; started: boolean; read: number; observations: number; resolved: boolean; ambiguous: boolean }
const scalar = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** Saved windows, not capture-file ownership, define the evidence boundary. */
export async function getIRacingIncidentReport(sessionId: number): Promise<IRacingIncidentReport | null> {
  const session = await db.select().from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.gameId, "iracing"))).get();
  if (!session) return null;
  const rows = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).orderBy(asc(laps.lapNumber), asc(laps.id)).all();
  const inputs: IRacingIncidentLapInput[] = rows.map(lap => ({ lapId: lap.id, lapNumber: lap.lapNumber, eligibleForCleanStreak: !!lap.isValid && Number.isFinite(lap.lapTime) && lap.lapTime > 0 && !isPitCycleLap(lap) }));
  const reasons = new Set<IRacingIncidentCoverageReason>();
  const windows: Window[] = [];
  const missing: number[] = [];
  for (const lap of rows) {
    if (integer(lap.rawByteOffset) !== null && integer(lap.rawFrameCount) !== null && lap.rawFrameCount! > 0) windows.push({ lapId: lap.id, offset: lap.rawByteOffset!, count: lap.rawFrameCount!, started: false, read: 0, observations: 0, resolved: false, ambiguous: false });
    else missing.push(lap.id);
  }
  if (missing.length) reasons.add("missing-lap-window");
  const unavailable = async (reason: IRacingIncidentCoverageReason): Promise<IRacingIncidentReport> => {
    reasons.add(reason);
    const evidence = await reduceIRacingIncidents(inputs, []);
    const { incidentStatus, surfaceStatus, reasons: _reasons, ...metrics } = evidence;
    return { sessionId, ...metrics, coverage: { scope: "recorded-laps", totalLaps: rows.length, lapsWithCapture: 0, incidentStatus, surfaceStatus, reasons: [...reasons] } };
  };
  if (session.source === "motec" || session.rawFile?.endsWith(".motec.zip")) return unavailable("unsupported-capture");
  if (!session.rawFile) return unavailable("capture-unavailable");
  try { await stat(session.rawFile); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return unavailable("capture-unavailable"); throw error; }
  if (!windows.length) return unavailable("missing-lap-window");
  windows.sort((left, right) => left.offset - right.offset || left.lapId - right.lapId);
  const source: SessionCaptureSource = { rawFile: session.rawFile, source: session.source, gameId: "iracing", carId: session.carId, trackId: session.trackId, captureFormatVersion: session.captureFormatVersion };
  async function* observations(): AsyncGenerator<IRacingIncidentInput> {
    let decoder = createIRacingSourceDecoderState();
    let inContext = false;
    let ownedPreviously = false;
    for (const lapId of missing) yield { kind: "break", reason: "capture-gap", lapId };
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
      if (record.kind !== "frame") {
        if (record.kind === "segment-boundary") decoder = createIRacingSourceDecoderState();
        if (record.kind === "segment-context") inContext = true;
        if (record.kind === "segment-context-end") inContext = false;
        const active = windows.filter(window => window.started && !window.resolved);
        if (active.length) for (const window of active) yield { kind: "break", reason: "segment-boundary", lapId: window.lapId };
        else yield { kind: "break", reason: "segment-boundary" };
        ownedPreviously = false;
        continue;
      }
      for (const window of windows) {
        if (window.resolved || window.started) continue;
        if (record.offset === window.offset) window.started = true;
        else if (record.offset > window.offset) {
          window.resolved = true; reasons.add("missing-lap-window");
          yield { kind: "break", reason: "capture-gap", lapId: window.lapId };
        }
      }
      const active = windows.filter(window => window.started && !window.resolved);
      if (active.length > 1) {
        reasons.add("missing-lap-window");
        for (const window of active) { window.ambiguous = true; yield { kind: "break", reason: "capture-gap", lapId: window.lapId }; }
      }
      const decoded = decodeIRacingSourceFrame(record.frame, decoder);
      if (!decoded) {
        decoder = createIRacingSourceDecoderState();
        if (active.length) for (const window of active) yield { kind: "break", reason: "decode-failure", lapId: window.lapId };
        else yield { kind: "break", reason: "decode-failure" };
      }
      const owned = active.length === 1 && !inContext && decoded !== null;
      if (!owned && ownedPreviously) yield { kind: "break", reason: "capture-gap" };
      if (owned) {
        const window = active[0], native = decoded.session, values = decoded.values;
        window.observations++;
        yield { kind: "sample", lapId: window.lapId, rawOffset: record.offset, nativeSessionUid: `${native.subSessionId}:${native.sessionId}:${native.sessionNum}`, driverCarIdx: native.driverCarIdx, sessionTick: integer(values.SessionTick), sessionTimeSec: scalar(values.SessionTime), incidentPoints: scalar(values.PlayerCarMyIncidentCount), surface: scalar(values.PlayerTrackSurface) };
      }
      ownedPreviously = owned;
      for (const window of active) { window.read++; if (window.read === window.count) window.resolved = true; }
      // Return closes the strict iterator before unrelated malformed or growing tails.
      if (windows.every(window => window.resolved)) break;
    }
    for (const window of windows) {
      if (!window.started || window.read < window.count) {
        reasons.add("missing-lap-window");
        yield { kind: "break", reason: "capture-gap", lapId: window.lapId };
      }
    }
  }
  let evidence;
  try { evidence = await reduceIRacingIncidents(inputs, observations()); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Legacy full-frame captures are not supported")) return unavailable("unsupported-capture");
    throw error;
  }
  for (const reason of evidence.reasons) reasons.add(reason);
  const events: IRacingIncidentEvent[] = [];
  const byLap = new Map<number, typeof evidence.events>();
  for (const event of evidence.events) { const group = byLap.get(event.lapId); if (group) group.push(event); else byLap.set(event.lapId, [event]); }
  const targets = new Map<string, IRacingIncidentEvent["replay"]>();
  for (const [lapId, lapEvents] of byLap) {
    const lap = await getLapById(lapId);
    if (!lap || lap.parseError || lap.sessionId !== sessionId || lap.gameId !== "iracing") continue;
    // Build both source-tick and millisecond-only indices once per retained lap.
    const lookup = new Map<string, number | null>();
    const add = (key: string, index: number) => lookup.set(key, lookup.has(key) ? null : index);
    lap.telemetry.forEach((packet, index) => {
      if (!Number.isFinite(packet.CurrentRaceTime) || packet.CurrentRaceTime < 0) return;
      const key = `${packet.sessionUID}\0${Math.round(packet.CurrentRaceTime * 1000)}`;
      add(key, index);
      if (integer(packet.iracing?.sessionTick) !== null) add(`${key}\0${packet.iracing!.sessionTick}`, index);
    });
    for (const event of lapEvents) {
      const reference = event.seekReference;
      const key = `${reference.nativeSessionUid}\0${Math.round(reference.sessionTimeSec * 1000)}${reference.sessionTick === null ? "" : `\0${reference.sessionTick}`}`;
      const index = lookup.get(key);
      if (index === null || index === undefined) continue;
      const time = lap.telemetry[index].CurrentLap;
      targets.set(event.id, { frameIndex: index, lapTimeSec: Number.isFinite(time) && time >= 0 ? time : null });
    }
  }
  for (const { seekReference: _reference, ...event } of evidence.events) events.push({ ...event, replay: targets.get(event.id) ?? null });
  const { incidentStatus, surfaceStatus, reasons: _reasons, events: _events, ...metrics } = evidence;
  return { sessionId, ...metrics, events, coverage: { scope: "recorded-laps", totalLaps: rows.length, lapsWithCapture: windows.filter(window => window.started && window.read === window.count && window.observations > 0).length, incidentStatus, surfaceStatus, reasons: [...reasons] } };
}
