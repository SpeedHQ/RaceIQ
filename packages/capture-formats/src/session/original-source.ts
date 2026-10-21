import type { DriverAttributionStint, DriverDurationAttribution } from "@raceiq/shared/driver-attribution";
import type { LapClassification } from "@raceiq/shared/racing/lap-classification";

/** Coordinates refer to this exact uncompressed sparse capture, never another representation. */
export interface PortableLapIdentity {
  lapGuid: string | null;
  lapGuidStatus: "resolved" | "held_ambiguous";
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason: string | null;
  /** Older portable archives omit classification; absence remains unknown. */
  classification?: LapClassification | null;
  rawByteOffset: number;
  rawFrameCount: number;
  /** Only the explicit final completion frame may overlap the next lap's owned span. */
  trailingContextFrameCount?: number;
  sectorTimes: number[] | null;
  recordedAt: string | null;
  totalTimeMs: number | null;
  sectorTimesMs: number[] | null;
  createdAt: string;
  driverAttribution: "Self" | "Other" | "Mixed" | "Unknown" | null;
  driverAttributionStints: DriverAttributionStint[] | null;
  sourceClockDomain: string | null;
  sourceLapStartMs: number | null;
  sourceLapEndMs: number | null;
}

/** Unsigned provenance, not human-identity or authenticity certification. */
export interface PortableCaptureIdentity {
  schemaVersion: 1;
  originalActivityId: string | null;
  /** Immutable source revision claim; this alone does not prove full coverage. */
  sourceRevision: string | null;
  ownerUserId: string | null;
  sourceAuthorUserId: string | null;
  sourceAuthorDisplayName: string | null;
  ownership: "mine" | "others";
  representation: {
    coordinates: "capture-byte-v1";
    contentHash: string;
    kind: "original" | "partial" | "downsample";
  };
  /**
   * Complete interval [0, sourceRecordCount) of original native records.
   * Includes native parser/bootstrap controls, excludes container headers and
   * synthetic per-member replay context. Hash uses updateNativeRecordDigest
   * in original order, including original source timestamps.
   * Only a durable closed, gap-free source proof may populate this descriptor.
   */
  originalSource: {
    coordinates: "native-record-v1";
    sourceRevision: string;
    originalLapGuids: readonly string[];
    sourceRecordCount: number;
    nativeRecordHash: string;
  } | null;
  session: {
    createdAt: string;
    sessionType: string | null;
    driverAttribution: "Self" | "Other" | "Mixed" | "Unknown" | null;
    driverAttributionStints: DriverAttributionStint[] | null;
    frameClock?: "capture_utc" | "unknown";
    clockAnchor?: { frameTimeMs: number; utcTimeMs: number } | null;
    /** Present only for a proven full original, never a selected or downsampled copy. */
    duration?: { status: "available" | "unavailable"; elapsedSeconds: number | null; attribution: DriverDurationAttribution | null } | null;
  };
  laps: PortableLapIdentity[];
}
