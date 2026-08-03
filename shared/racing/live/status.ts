import type { SessionMeta } from "../sessions/types";
export interface ServerStatus {
  udpReceiving: boolean;
  packetsPerSec: number;
  connectedClients: number;
  droppedPackets: number;
  currentSession: SessionMeta | null;
}
