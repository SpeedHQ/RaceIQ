import { Fragment, useMemo, useState } from "react";
import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { LiveCompetitorView } from "@/lib/live-telemetry-view";
import type { OpponentSourceStatusV1 } from "../../../../shared/telemetry/live/contracts";

export interface AccOpponentStandingsProps {
  competitors: readonly LiveCompetitorView[];
  playerCarIndex?: number;
  opponentSource: OpponentSourceStatusV1 | null | undefined;
  title?: string;
}

function lap(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const milliseconds = Math.round(seconds * 1_000);
  return `${Math.floor(milliseconds / 60_000)}:${((milliseconds % 60_000) / 1_000).toFixed(3).padStart(6, "0")}`;
}

export function AccOpponentStandings({ competitors, playerCarIndex, opponentSource, title = "ACC standings" }: AccOpponentStandingsProps) {
  const [focused, setFocused] = useState(true);
  const sorted = useMemo(() => [...competitors].sort((a, b) => a.position! - b.position!), [competitors]);
  const playerRank = sorted.findIndex((row) => row.carIndex === playerCarIndex);
  const available = opponentSource?.state === "available" && sorted.length > 0 && playerRank >= 0;
  const rows = sorted.map((row, rank) => ({ row, rank })).filter(({ row, rank }) => !focused || sorted.length <= 7 || row.position === 1 || Math.abs(rank - playerRank) <= 2);
  return <Card size="sm" className="shrink-0" role="region" aria-label={title}>
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      {!available && <CardDescription role="status">Opponent standings {opponentSource?.state === "available" ? "unavailable" : opponentSource?.state ?? "unavailable"}: {opponentSource?.state === "available" ? "incomplete-grid" : opponentSource?.reasonCode ?? "source-not-captured"}.</CardDescription>}
      {available && sorted.length > 7 && <CardAction><Button type="button" variant="plain" size="content" onClick={() => setFocused((value) => !value)}>{focused ? `Show all (${sorted.length})` : "Focus view"}</Button></CardAction>}
    </CardHeader>
    {available && <CardContent><Table aria-label={title}>
      <THead><TH>Pos</TH><TH>Driver</TH><TH>Class</TH><TH>Gap</TH><TH>Laps</TH><TH>Last lap</TH><TH>Pit</TH><TH>Status</TH></THead>
      <TBody>{rows.map(({ row, rank }, index) => <Fragment key={row.carIndex}>
        {rank > (rows[index - 1]?.rank ?? -1) + 1 && <TRow variant="separator"><TD colSpan={8}>…</TD></TRow>}
        <TRow selected={row.carIndex === playerCarIndex} aria-current={row.carIndex === playerCarIndex ? "true" : undefined}>
          <TD>{row.position}</TD><TD>{row.name || "—"}</TD><TD>{row.className || row.classId || "—"}</TD>
          <TD>{row.gapToAheadS === undefined ? "—" : `+${row.gapToAheadS.toFixed(3)}`}</TD><TD>{row.lapsComplete}</TD>
          <TD>{lap(row.lastLapS)}{row.lastLapValid === false && row.lastLapS !== undefined && row.lastLapS > 0 ? " (invalid)" : ""}</TD>
          <TD>{row.pitStatus === "out" ? "On track" : row.pitStatus === "pit_lane" ? "Pit lane" : row.pitStatus === "pit_entry" ? "Pit entry" : row.pitStatus === "pit_exit" ? "Pit exit" : row.pitStatus ?? "—"}</TD>
          <TD>{row.connected === false ? "Disconnected" : "Connected"}</TD>
        </TRow>
      </Fragment>)}{rows.length > 0 && rows[rows.length - 1]!.rank < sorted.length - 1 && <TRow variant="separator"><TD colSpan={8}>…</TD></TRow>}</TBody>
    </Table></CardContent>}
  </Card>;
}
