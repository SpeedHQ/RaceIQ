import dgram from "node:dgram";
import type { OpponentLapFactV1 } from "../../live-strategy/opponent-pace-tracker";

export interface AccBroadcastingLapInfo { carIndex: number; driverName: string; carModel: string; cupCategory: string; lapNumber: number; lapTimeMs: number; isInvalid: boolean; inPit: boolean; sessionTimeMs: number; eventIndex: number; }
export interface AccBroadcastingPositionInfo { carIndex: number; x: number; z: number; speedMps: number; isPlayer: boolean; sessionTimeMs: number; eventIndex: number; }
export interface AccBroadcastingOptions { port?: number; connectionPassword?: string; updateIntervalMs?: number; onLap?: (fact: OpponentLapFactV1) => void; onPosition?: (position: AccBroadcastingPositionInfo) => void; }
export const ACC_BROADCAST_DEFAULTS = { port: 9000, connectionPassword: "", updateIntervalMs: 250 } as const;
export function stableAccClassId(carModel: string, cupCategory: string): string | null {
  const value = `${carModel} ${cupCategory}`.toLowerCase();
  if (!value.trim()) return null;
  if (value.includes("gt3")) return "gt3";
  if (value.includes("gt4")) return "gt4";
  if (value.includes("cup")) return "cup";
  return null;
}
export function decodeAccBroadcastingLap(payload: Uint8Array | string): AccBroadcastingLapInfo | null {
  try {
    const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    const v = JSON.parse(text) as Record<string, unknown>;
    const n = (key: string) => typeof v[key] === "number" && Number.isFinite(v[key]) ? v[key] as number : null;
    const s = (key: string) => typeof v[key] === "string" ? v[key] as string : "";
    const carIndex = n("carIndex"), lapNumber = n("lapNumber"), lapTimeMs = n("lapTimeMs");
    if (carIndex === null || lapNumber === null || lapTimeMs === null || lapNumber <= 0 || lapTimeMs <= 0) return null;
    return { carIndex, driverName: s("driverName"), carModel: s("carModel"), cupCategory: s("cupCategory"), lapNumber, lapTimeMs, isInvalid: v.isInvalid === true, inPit: v.inPit === true, sessionTimeMs: n("sessionTimeMs") ?? 0, eventIndex: n("eventIndex") ?? 0 };
  } catch { return null; }
}
export function decodeAccBroadcastingPosition(payload: Uint8Array | string): AccBroadcastingPositionInfo | null {
  try {
    const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    const v = JSON.parse(text) as Record<string, unknown>;
    const n = (key: string) => typeof v[key] === "number" && Number.isFinite(v[key]) ? v[key] as number : null;
    const carIndex = n("carIndex"), x = n("x"), z = n("z");
    if (carIndex === null || x === null || z === null) return null;
    return { carIndex, x, z, speedMps: n("speedMps") ?? 0, isPlayer: v.isPlayer === true, sessionTimeMs: n("sessionTimeMs") ?? 0, eventIndex: n("eventIndex") ?? 0 };
  } catch { return null; }
}
export function accBroadcastingFact(info: AccBroadcastingLapInfo, sessionId: string, timelineEpoch: number, sourceSequence: number): OpponentLapFactV1 | null {
  const classId = stableAccClassId(info.carModel, info.cupCategory);
  if (!classId || info.isInvalid || info.inPit || !info.driverName) return null;
  return { factId: `acc/${sessionId}/${timelineEpoch}/${info.carIndex}/${info.lapNumber}/${info.eventIndex}`, gameId: "acc", sessionId, timelineEpoch, participantId: String(info.carIndex), participantName: info.driverName, classId, className: info.cupCategory || info.carModel, lapNumber: info.lapNumber, lapTimeMs: info.lapTimeMs, valid: true, inPit: false, completedSessionTimeMs: info.sessionTimeMs, sourceSequence, sourceQuality: "native-validity" };
}
export class AccBroadcastingClient {
  readonly port: number; readonly connectionPassword: string; readonly updateIntervalMs: number;
  private socket: dgram.Socket | null = null;
  constructor(options: AccBroadcastingOptions = {}) { this.port = options.port ?? ACC_BROADCAST_DEFAULTS.port; this.connectionPassword = options.connectionPassword ?? ACC_BROADCAST_DEFAULTS.connectionPassword; this.updateIntervalMs = Math.min(1000, Math.max(100, options.updateIntervalMs ?? ACC_BROADCAST_DEFAULTS.updateIntervalMs)); }
  start(): void { if (this.socket) return; this.socket = dgram.createSocket("udp4"); this.socket.bind(this.port); }
  async stop(): Promise<void> { const socket = this.socket; this.socket = null; if (socket) await new Promise<void>((resolve) => socket.close(() => resolve())); }
}
