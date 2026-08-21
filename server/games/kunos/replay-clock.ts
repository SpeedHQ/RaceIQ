const KUNOS_CAPTURE_INTERVAL_MS = 10;
const KUNOS_PHYSICS_HZ = 333;
const MAX_FORWARD_PACKET_DELTA = 0x7fff_ffff;

export interface KunosReplayClock {
  previousPacketId: number | null;
  timestampMS: number;
}

export function createKunosReplayClock(): KunosReplayClock {
  return {
    previousPacketId: null,
    timestampMS: 0,
  };
}

export function isKunosReplayClock(value: unknown): value is KunosReplayClock {
  if (typeof value !== "object" || value === null) return false;
  if (!("previousPacketId" in value) || !("timestampMS" in value)) return false;
  const previousPacketId = value.previousPacketId;
  const timestampMS = value.timestampMS;
  return (previousPacketId === null || (typeof previousPacketId === "number" && Number.isInteger(previousPacketId)))
    && typeof timestampMS === "number"
    && Number.isFinite(timestampMS)
    && timestampMS >= 0;
}

/**
 * Resolve capture time without consulting wall clock. Persisted timestamps win;
 * legacy recordings derive elapsed source time from physics packet sequence and
 * retain 100 Hz capture cadence while source updates stall.
 */
export function resolveKunosReplayTimestamp(
  clock: KunosReplayClock,
  packetId: number,
  persistedTimestampMS?: number | null,
): number {
  if (persistedTimestampMS != null && Number.isFinite(persistedTimestampMS) && persistedTimestampMS >= 0) {
    clock.previousPacketId = packetId;
    clock.timestampMS = persistedTimestampMS;
    return persistedTimestampMS;
  }

  if (clock.previousPacketId === null) {
    clock.previousPacketId = packetId;
    return clock.timestampMS;
  }

  const packetDelta = ((packetId >>> 0) - (clock.previousPacketId >>> 0)) >>> 0;
  const sourceElapsedMS = packetDelta <= MAX_FORWARD_PACKET_DELTA
    ? (packetDelta * 1_000) / KUNOS_PHYSICS_HZ
    : 0;
  clock.previousPacketId = packetId;
  clock.timestampMS += Math.max(KUNOS_CAPTURE_INTERVAL_MS, sourceElapsedMS);
  return Math.round(clock.timestampMS);
}
