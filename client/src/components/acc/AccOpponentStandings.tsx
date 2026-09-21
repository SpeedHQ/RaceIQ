import { useMemo, useState } from "react";
import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import type { LiveCompetitorView } from "@/lib/live-telemetry-view";
import type { OpponentSourceStatusV1 } from "../../../../shared/telemetry/live/contracts";

export interface AccOpponentStandingsProps { competitors: readonly LiveCompetitorView[]; playerCarIndex?: number; opponentSource: OpponentSourceStatusV1 | null | undefined; title?: string; }
const lap = (seconds?: number) => seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 ? "—" : `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
export function AccOpponentStandings({ competitors, playerCarIndex, opponentSource, title = "ACC standings" }: AccOpponentStandingsProps) {
  const [focused, setFocused] = useState(true);
  const sorted = useMemo(() => [...competitors].filter((row) => Number.isFinite(row.position)).sort((a, b) => (a.position! - b.position!)), [competitors]);
  if (!opponentSource || opponentSource.state !== "available") return <section className="rounded-lg border p-4"><h2 className="font-semibold">{title}</h2><p className="text-muted-foreground">Opponent standings unavailable: {opponentSource?.reasonCode ?? "source-not-captured"}.</p></section>;
  const rows = sorted.length > 7 && focused ? sorted.filter((row) => row.position === 1 || Math.abs((row.position ?? 0) - (sorted.find((candidate) => candidate.carIndex === playerCarIndex)?.position ?? 0)) <= 2) : sorted;
  const omitted = rows.length !== sorted.length;
  return <section className="rounded-lg border p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{title}</h2>{sorted.length > 7 && <button className="text-sm underline" onClick={() => setFocused((value) => !value)}>{focused ? `Show all (${sorted.length})` : "Focus view"}</button>}</div><Table><THead><TRow><TH>Pos</TH><TH>Driver</TH><TH>Class</TH><TH>Lap</TH><TH>Pit</TH><TH>Status</TH></TRow></THead><TBody>{rows.map((row, index) => <TRow key={row.carIndex ?? `${row.position}-${index}`}><TD>{row.position ?? "—"}</TD><TD>{row.name ?? "—"}</TD><TD>{row.className ?? row.classId ?? "—"}</TD><TD>{lap(row.lastLapS)}</TD><TD>{row.pitStatus ?? "—"}</TD><TD>{row.connected === false ? "Disconnected" : "Connected"}</TD></TRow>)}{omitted && <TRow><TD colSpan={6}>…</TD></TRow>}</TBody></Table></section>;
}
