import type { Transaction } from "@libsql/client/sqlite3";
import { client } from "./index";
import type { PortableCaptureIdentity } from "@raceiq/capture-formats/session/framing";
import { dashboardDurationAttribution } from "../driver-summary/dashboard-input";

export interface OriginalActivitySourceProof {
  schemaVersion: 1;
  originalActivityId: string;
  sourceRevision: string;
  originalLapGuids: readonly string[];
  coverage: "complete";
  origin: "native_capture" | "verified_portable";
  ownerUserId: string | null;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function canonicalGuids(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((guid): guid is string => typeof guid === "string" && GUID.test(guid))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value].sort();
}
async function membership(tx: Transaction, sessionId: number): Promise<string[] | null> {
  const result = await tx.execute({ sql: `SELECT l.lap_guid,r.lap_guid AS reconciled_guid,r.source_guid,r.status,
      l.raw_byte_offset,l.raw_frame_count,l.source_clock_domain,l.source_lap_start_ms,l.source_lap_end_ms
    FROM laps l LEFT JOIN lap_guid_reconciliation r ON r.lap_id=l.id WHERE l.session_id=? ORDER BY l.lap_guid`, args: [sessionId] });
  if (result.rows.some((row) => row.status !== "resolved" || row.lap_guid !== row.reconciled_guid
    || (row.source_guid !== null && row.source_guid !== row.lap_guid))) return null;
  const rawStarts = new Set<number>();
  const intervals: { domain: string; start: number; end: number }[] = [];
  for (const row of result.rows) {
    if (typeof row.raw_byte_offset === "number" && Number(row.raw_frame_count) > 0) {
      if (rawStarts.has(row.raw_byte_offset)) return null;
      rawStarts.add(row.raw_byte_offset);
    }
    if (row.source_clock_domain !== null && row.source_lap_start_ms !== null && row.source_lap_end_ms !== null) {
      if (typeof row.source_clock_domain !== "string" || !row.source_clock_domain
        || typeof row.source_lap_start_ms !== "number" || !Number.isFinite(row.source_lap_start_ms)
        || typeof row.source_lap_end_ms !== "number" || !Number.isFinite(row.source_lap_end_ms)
        || row.source_lap_end_ms < row.source_lap_start_ms) return null;
      intervals.push({ domain: row.source_clock_domain, start: row.source_lap_start_ms, end: row.source_lap_end_ms });
    }
  }
  intervals.sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : a.start - b.start || a.end - b.end);
  let previous: typeof intervals[number] | undefined;
  for (const interval of intervals) {
    if (previous?.domain === interval.domain && previous.end > interval.start) return null;
    previous = interval;
  }
  return canonicalGuids(result.rows.map((row) => row.lap_guid));
}

/** Pipeline-only closure attestation: never called for replay, recovery, or an active source. */
export async function closeNativeOriginalActivitySource(sessionId: number, closure: {
  sourceRevision: string; lapCount: number; gapCount: number;
}): Promise<void> {
  if (!closure.sourceRevision.trim() || !Number.isSafeInteger(closure.lapCount) || closure.lapCount < 0
    || !Number.isSafeInteger(closure.gapCount) || closure.gapCount < 0) throw new Error("Invalid native original closure");
  const tx = await client.transaction("write");
  try {
    const result = await tx.execute({ sql: `SELECT original_activity_id FROM sessions
      WHERE id=? AND native_capture_origin=1 AND ownership='mine' AND cloud_import_origin IS NULL AND cloud_import_lap_id IS NULL`, args: [sessionId] });
    const activityId = result.rows[0]?.original_activity_id;
    if (typeof activityId !== "string" || !activityId) throw new Error("Native source original identity is unavailable");
    const prior = await tx.execute({ sql: "SELECT * FROM native_original_source_closures WHERE session_id=?", args: [sessionId] });
    if (prior.rows.length) {
      const row = prior.rows[0]!;
      if (row.original_activity_id !== activityId || row.source_revision !== closure.sourceRevision
        || Number(row.lap_count) !== closure.lapCount || Number(row.gap_count) !== closure.gapCount) throw new Error("Native original closure cannot be replaced");
    } else {
      await tx.execute({ sql: "INSERT INTO native_original_source_closures(session_id,original_activity_id,source_revision,lap_count,gap_count) VALUES(?,?,?,?,?)",
        args: [sessionId, activityId, closure.sourceRevision, closure.lapCount, closure.gapCount] });
    }
    await bindSourceRevision(tx, sessionId, closure.sourceRevision);
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
}

async function bindSourceRevision(tx: Transaction, sessionId: number, sourceRevision: string): Promise<void> {
  if (!sourceRevision.trim()) throw new Error("Original source revision is required");
  const bound = await tx.execute({ sql: `UPDATE sessions SET original_source_revision=? WHERE id=?
    AND (original_source_revision IS NULL OR original_source_revision=?)`, args: [sourceRevision, sessionId, sourceRevision] });
  if (bound.rowsAffected !== 1) throw new Error("Original source revision cannot be reassigned");
}

/** Positively verifies closure and every resolved original lap, not just personal laps. */
export async function finalizeNativeOriginalActivitySource(sessionId: number): Promise<void> {
  const tx = await client.transaction("write");
  try {
    const result = await tx.execute({ sql: `SELECT s.original_activity_id,s.owner_user_id,c.source_revision,c.lap_count,c.gap_count
      FROM sessions s JOIN native_original_source_closures c ON c.session_id=s.id AND c.original_activity_id=s.original_activity_id
      WHERE s.id=? AND s.native_capture_origin=1 AND s.ownership='mine' AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL`, args: [sessionId] });
    const row = result.rows[0];
    const guids = row ? await membership(tx, sessionId) : null;
    if (row && guids && Number(row.gap_count) === 0 && guids.length === Number(row.lap_count)
      && typeof row.source_revision === "string" && row.source_revision.length > 0) {
      await registerFootprint(tx, sessionId, {
        schemaVersion: 1, originalActivityId: String(row.original_activity_id), sourceRevision: row.source_revision,
        originalLapGuids: guids, ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id),
        coverage: "complete", origin: "native_capture",
      }, true);
    }
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
}

async function registerFootprint(tx: Transaction, sessionId: number, proof: OriginalActivitySourceProof, claimable: boolean, nativeSourceHash: string | null = null): Promise<void> {
  const guids = canonicalGuids(proof.originalLapGuids);
  if (!guids || !proof.originalActivityId || !proof.sourceRevision) throw new Error("Original source identity is incomplete");
  await bindSourceRevision(tx, sessionId, proof.sourceRevision);
  const json = JSON.stringify(guids);
  const existing = await tx.execute({ sql: "SELECT * FROM original_activity_sources WHERE original_activity_id=?", args: [proof.originalActivityId] });
  const prior = existing.rows[0];
  if (prior && (prior.source_revision !== proof.sourceRevision || prior.original_lap_guids_json !== json || prior.owner_user_id !== proof.ownerUserId)) {
    throw new Error("Original source membership or owner conflicts with retained identity");
  }
  if (nativeSourceHash !== null && !/^sha256:[0-9a-f]{64}$/.test(nativeSourceHash)) throw new Error("Native source digest is invalid");
  if (prior?.native_source_hash != null && nativeSourceHash !== null && prior.native_source_hash !== nativeSourceHash) throw new Error("Original source digest conflicts with retained history");
  for (const guid of guids) {
    await retainOriginalLapIdentityInTransaction(tx, guid, proof.originalActivityId, proof.ownerUserId, proof.sourceRevision);
  }
  if (!prior) await tx.execute({ sql: `INSERT INTO original_activity_sources(original_activity_id,source_revision,original_lap_guids_json,owner_user_id,origin,claimable,native_source_hash) VALUES(?,?,?,?,?,?,?)`,
    args: [proof.originalActivityId, proof.sourceRevision, json, proof.ownerUserId, proof.origin, claimable ? 1 : 0, nativeSourceHash] });
  else if (nativeSourceHash !== null && prior.native_source_hash === null) {
    await tx.execute({ sql: "UPDATE original_activity_sources SET native_source_hash=? WHERE original_activity_id=?", args: [nativeSourceHash, proof.originalActivityId] });
  }
  await tx.execute({ sql: `INSERT INTO original_activity_representations(session_id,original_activity_id,source_revision,origin) VALUES(?,?,?,?)
    ON CONFLICT(session_id) DO NOTHING`, args: [sessionId, proof.originalActivityId, proof.sourceRevision, proof.origin] });
}

/** Minimal identity is retained even for a one-lap borrowed/partial representation. */
export async function retainOriginalLapIdentityInTransaction(tx: Transaction, lapGuid: string, originalActivityId: string | null, ownerUserId: string | null, sourceRevision: string | null = null): Promise<void> {
  if (!GUID.test(lapGuid)) throw new Error("Original lap GUID is invalid");
  const assigned = await tx.execute({ sql: "SELECT original_activity_id,owner_user_id,source_revision FROM original_activity_source_laps WHERE lap_guid=?", args: [lapGuid] });
  const row = assigned.rows[0];
  if (row && (row.owner_user_id !== ownerUserId || (row.original_activity_id !== null && row.original_activity_id !== originalActivityId))) {
    throw new Error("Original lap belongs to another source or owner");
  }
  if (row?.source_revision != null && sourceRevision !== null && row.source_revision !== sourceRevision) throw new Error("Original lap source revision conflicts with retained history");
  if (!row) await tx.execute({ sql: "INSERT INTO original_activity_source_laps(lap_guid,original_activity_id,owner_user_id,source_revision) VALUES(?,?,?,?)", args: [lapGuid, originalActivityId, ownerUserId, sourceRevision] });
  else if (row.original_activity_id === null && originalActivityId !== null) {
    await tx.execute({ sql: "UPDATE original_activity_source_laps SET original_activity_id=? WHERE lap_guid=?", args: [originalActivityId, lapGuid] });
  }
  if (row && row.source_revision === null && sourceRevision !== null) {
    await tx.execute({ sql: "UPDATE original_activity_source_laps SET source_revision=? WHERE lap_guid=?", args: [sourceRevision, lapGuid] });
  }
}
/** Called only after portable bytes, exact windows, and closed original membership have been verified. */
export async function registerVerifiedPortableOriginalInTransaction(tx: Transaction, sessionId: number, proof: OriginalActivitySourceProof, nativeRecordHash: string): Promise<void> {
  if (typeof nativeRecordHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(nativeRecordHash)) throw new Error("Complete portable native digest is required");
  const actual = await membership(tx, sessionId);
  const expected = canonicalGuids(proof.originalLapGuids);
  const session = await tx.execute({ sql: "SELECT original_activity_id,owner_user_id,ownership,cloud_import_origin FROM sessions WHERE id=?", args: [sessionId] });
  const row = session.rows[0];
  if (!actual || !expected || JSON.stringify(actual) !== JSON.stringify(expected) || !row
    || row.original_activity_id !== proof.originalActivityId || row.owner_user_id !== proof.ownerUserId
    || row.cloud_import_origin !== null || proof.origin !== "verified_portable") {
    throw new Error("Portable representation does not match its original source");
  }
  await registerFootprint(tx, sessionId, proof, false, nativeRecordHash);
}

/** Bind only after reconstructing the entire proven original, never a selected lap artifact. */
export async function bindOriginalActivityNativeSourceHash(sessionId: number, nativeRecordHash: string): Promise<void> {
  const proof = await readOriginalActivitySourceProof(sessionId, { includeBorrowed: true });
  if (!proof) throw new Error("Complete original source proof is unavailable");
  const tx = await client.transaction("write");
  try {
    const actual = await membership(tx, sessionId);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(proof.originalLapGuids)) throw new Error("Original source changed while hashing");
    await registerFootprint(tx, sessionId, proof, false, nativeRecordHash);
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
}

/** Missing/deleted/resegmented or partially restored representations stay held; footprint remains. */
export async function readOriginalActivitySourceProof(sessionId: number, options: { includeBorrowed?: boolean } = {}): Promise<OriginalActivitySourceProof | null> {
  const tx = await client.transaction("read");
  try {
    const result = await tx.execute({ sql: `SELECT f.*,r.origin AS representation_origin,
      c.original_activity_id AS closed_activity_id,c.source_revision AS closed_revision,c.lap_count AS closed_lap_count,c.gap_count AS closed_gap_count
      FROM original_activity_representations r
      JOIN original_activity_sources f ON f.original_activity_id=r.original_activity_id AND f.source_revision=r.source_revision
      JOIN sessions s ON s.id=r.session_id AND s.original_activity_id=f.original_activity_id
        AND s.owner_user_id IS f.owner_user_id AND s.original_source_revision=f.source_revision
      LEFT JOIN native_original_source_closures c ON c.session_id=s.id
      WHERE r.session_id=? AND (?=1 OR s.ownership='mine') AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
        AND s.downsampled_frequency_hz IS NULL`, args: [sessionId, options.includeBorrowed ? 1 : 0] });
    const row = result.rows[0];
    let proof: OriginalActivitySourceProof | null = null;
    if (row) {
      let expected: string[] | null = null;
      try { expected = canonicalGuids(JSON.parse(String(row.original_lap_guids_json))); } catch { /* Invalid footprint is not proof. */ }
      const actual = await membership(tx, sessionId);
      const durableCoverage = row.representation_origin === "native_capture"
        ? row.closed_activity_id === row.original_activity_id && row.closed_revision === row.source_revision
          && Number(row.closed_gap_count) === 0 && row.closed_gap_count !== null && expected?.length === Number(row.closed_lap_count)
        : row.representation_origin === "verified_portable" && typeof row.native_source_hash === "string" && /^sha256:[0-9a-f]{64}$/.test(row.native_source_hash);
      if (expected && actual && JSON.stringify(expected) === JSON.stringify(actual)
        && durableCoverage) {
        proof = { schemaVersion: 1, originalActivityId: String(row.original_activity_id), sourceRevision: String(row.source_revision),
          originalLapGuids: expected, coverage: "complete", origin: row.representation_origin === "native_capture" ? "native_capture" : "verified_portable",
          ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id) };
      }
    }
    await tx.commit();
    return proof;
  } catch (error) { await tx.rollback(); throw error; }
}

/** A selected copy or resegmented membership cannot restore full-original scalar facts. */
export async function readVerifiedPortableOriginalDuration(sessionId: number): Promise<NonNullable<PortableCaptureIdentity["session"]["duration"]> | null> {
  const proof = await readOriginalActivitySourceProof(sessionId);
  if (!proof) return null;
  const result = await client.execute({ sql: `SELECT s.verified_original_duration_json
    FROM sessions s JOIN original_activity_sources f ON f.original_activity_id=s.original_activity_id
      AND f.source_revision=s.original_source_revision AND f.owner_user_id IS s.owner_user_id
    WHERE s.id=? AND s.original_activity_id=? AND s.original_source_revision=?
      AND f.native_source_hash IS NOT NULL`, args: [sessionId, proof.originalActivityId, proof.sourceRevision] });
  const json = result.rows[0]?.verified_original_duration_json;
  if (typeof json !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.status !== "available" && value.status !== "unavailable") return null;
  if (value.status === "available"
    ? typeof value.elapsedSeconds !== "number" || !Number.isFinite(value.elapsedSeconds) || value.elapsedSeconds < 0
    : value.elapsedSeconds !== null) return null;
  const attribution = dashboardDurationAttribution(value.attribution);
  if (value.attribution !== null && attribution === null) return null;
  return { status: value.status, elapsedSeconds: value.elapsedSeconds as number | null, attribution };
}
