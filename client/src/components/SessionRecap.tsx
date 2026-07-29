import type { GameId, SessionRecap as SessionRecapDto } from "@shared/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import { useSessionRecap, useTrackOutline, useTrackSectorBoundaries } from "../hooks/queries";
import { drawTrack } from "../lib/canvas/draw-track";
import { formatLapTime } from "../lib/format";
import { getGameRoute, useGameId } from "../stores/game";
import { Button } from "./ui/button";

export type TrackOutlineData =
  | {
      points?: { x: number; z: number }[];
      labels?: { text: string; x: number; z: number }[];
      flipX?: boolean;
      recorded?: boolean;
      source?: string;
    }
  | { x: number; z: number }[];
export type TrackSectorBounds = { s1End: number; s2End: number } | null;

type SectorStatus = "record" | "session-best" | "lost";

const SECTOR_COLORS: Record<SectorStatus, string> = {
  record: "#c084fc",
  "session-best": "#34d399",
  lost: "#f87171",
};
const NEUTRAL_SECTOR_COLOR = "#64748b";

function sectorLabel(status: SectorStatus): string {
  switch (status) {
    case "record":
      return m.recap_sector_record();
    case "session-best":
      return m.recap_sector_session_best();
    case "lost":
      return m.recap_sector_lost();
  }
}

function SectorTrackMap({
  sectors,
  sourceStarts,
  outlineData,
  bounds,
}: {
  sectors: NonNullable<SessionRecapDto["sectors"]>;
  sourceStarts: number[] | null;
  outlineData?: TrackOutlineData;
  bounds?: TrackSectorBounds;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const points = Array.isArray(outlineData) ? outlineData : (outlineData?.points ?? null);
  const flipX = Array.isArray(outlineData) ? undefined : outlineData?.flipX;
  const sectorColors = useMemo<string[]>(() => {
    const byIndex = new Map(sectors.map((s) => [s.index, s]));
    return sectors.map((_, index) => {
      const status = byIndex.get(index + 1)?.status;
      return status ? SECTOR_COLORS[status] : NEUTRAL_SECTOR_COLOR;
    });
  }, [sectors]);
  const sectorStarts = useMemo(
    () => (sourceStarts?.length === sectors.length ? sourceStarts : sectors.length === 3 && bounds ? [0, bounds.s1End, bounds.s2End] : null),
    [sourceStarts, sectors.length, bounds],
  );
  const canDraw = !!points && points.length >= 3 && !!sectorStarts;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canDraw || !canvas || !points || !sectorStarts) return;
    let cancelled = false;
    const tryDraw = () => {
      if (cancelled) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(tryDraw);
        return;
      }
      drawTrack(canvas, points, false, null, 1, { x: 0, z: 0 }, { starts: sectorStarts }, flipX, sectorColors);
    };
    tryDraw();
    return () => {
      cancelled = true;
    };
  }, [canDraw, points, sectorStarts, flipX, sectorColors]);
  return (
    <div>
      <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">{m.recap_sectors()}</div>
      {canDraw && <canvas ref={canvasRef} className="w-full h-[220px]" aria-label={m.recap_sectors()} />}
      <div className="mt-2 flex flex-col gap-1">
        {sectors.map((s) => (
          <div key={s.index} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: SECTOR_COLORS[s.status] }} />
              <span className="text-app-text-muted font-medium">S{s.index}</span>
            </span>
            <span className="font-mono tabular-nums text-app-text/90">{s.bestLapSec.toFixed(3)}</span>
            <span className="text-[10px] text-app-text-dim">{sectorLabel(s.status)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-app-surface-alt/30 p-3">
      <div className="mb-1 min-h-7 break-words text-[10px] uppercase tracking-wider text-app-text-muted">{label}</div>
      <div className={`min-w-0 break-words text-xl font-mono font-black tabular-nums leading-none ${color ?? "text-app-text/90"}`}>{value}</div>
      {sub && <div className="mt-1 break-words text-[11px] text-app-text-dim">{sub}</div>}
    </div>
  );
}
function formatDelta(sec: number): string {
  return `${sec >= 0 ? "-" : "+"}${Math.abs(sec).toFixed(3)}`;
}
function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
function formatDuration(sec: number): string {
  const totalMin = Math.round(sec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${h}h ${min}m`;
}

function Sparkline({ laps }: { laps: SessionRecapDto["sparkline"] }) {
  if (laps.length < 2) return null;
  const width = 240,
    height = 48,
    pad = 4;
  const times = laps.map((l) => l.lapTimeSec).filter((t) => t > 0);
  if (times.length === 0) return null;
  const min = Math.min(...times),
    max = Math.max(...times),
    range = max - min || 1;
  const stepX = (width - pad * 2) / Math.max(1, laps.length - 1);
  const points = laps.map((l, i) => {
    const x = pad + i * stepX;
    const t = l.lapTimeSec > 0 ? l.lapTimeSec : max;
    const y = pad + (1 - (t - min) / range) * (height - pad * 2);
    return { x, y, lap: l };
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" role="img" aria-label={m.recap_pace()}>
      <title>{m.recap_pace()}</title>
      <path d={path} fill="none" stroke="currentColor" className="text-app-accent/50" strokeWidth={1.5} />
      {points.map((p) => (
        <circle key={p.lap.lapNumber} cx={p.x} cy={p.y} r={p.lap.isValid ? 2 : 2.5} className={p.lap.isValid ? "fill-app-accent" : "fill-red-400"} />
      ))}
    </svg>
  );
}

export function buildRecapText(recap: SessionRecapDto): string {
  const lines: string[] = [`RaceIQ — ${recap.trackName} · ${recap.carName}`];
  const best = recap.bestLapSec,
    pb = recap.personalBest;
  const bestPart = best != null ? `${m.recap_text_best()} ${formatLapTime(best)}` : null;
  const pbPart =
    pb?.isNew !== true ? null : pb.previousBestSec != null && best != null ? `${m.recap_new_pb()}, ${formatDelta(pb.previousBestSec - best)}` : `${m.recap_new_pb()}, ${m.recap_new_pb_first_ever()}`;
  const lapsLine = [`${recap.lapsValid} ${m.recap_text_laps()}`, bestPart ? (pbPart ? `${bestPart} (${pbPart})` : bestPart) : null].filter(Boolean).join(" · ");
  if (lapsLine) lines.push(lapsLine);
  if (recap.theoretical != null) lines.push(`${m.recap_text_theoretical()} ${formatLapTime(recap.theoretical.sumSec)} (${recap.theoretical.deltaToBestSec.toFixed(1)}s ${m.recap_left_on_table()})`);
  const tailParts: string[] = [];
  if (recap.consistency != null) tailParts.push(`${m.recap_text_consistency()} ${recap.consistency.rating}★`);
  if (recap.distanceM != null) tailParts.push(formatDistance(recap.distanceM));
  tailParts.push(`${formatDuration(recap.timeOnTrackSec)} ${m.recap_text_on_track()}`);
  if (tailParts.length > 0) lines.push(tailParts.join(" · "));
  return lines.join("\n");
}

export interface SessionRecapViewProps {
  recap: SessionRecapDto;
  gameId: GameId;
  linkToAnalyse?: boolean;
  copied?: boolean;
  onCopy: () => void;
  onAnalyse?: () => void;
  outlineData?: TrackOutlineData;
  bounds?: TrackSectorBounds;
}

export function SessionRecapView({ recap, gameId, linkToAnalyse = false, copied = false, onCopy, onAnalyse, outlineData, bounds }: SessionRecapViewProps) {
  const canAnalyse = linkToAnalyse && gameId === recap.gameId && recap.bestLapId != null && onAnalyse != null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="break-words text-base font-bold text-app-text/90">
            {recap.carName} · {recap.trackName}
          </div>
          <div className="mt-0.5 text-xs text-app-text-muted">{new Date(recap.createdAt).toLocaleString()}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canAnalyse && (
            <Button variant="app-outline" size="app-sm" onClick={onAnalyse}>
              {m.recap_analyse_best_lap()}
            </Button>
          )}
          <Button variant="app-outline" size="app-sm" onClick={onCopy}>
            {copied ? m.recap_copied() : m.recap_copy()}
          </Button>
        </div>
      </div>

      {recap.lapsTotal === 0 ? (
        <div className="p-6 text-center text-app-text-dim">{m.recap_no_laps()}</div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="grid min-w-0 gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))" }}>
              <Tile label={m.recap_laps()} value={`${recap.lapsValid}/${recap.lapsTotal}`} />
              {recap.bestLapSec != null && (
                <Tile
                  label={m.recap_best_lap()}
                  value={formatLapTime(recap.bestLapSec)}
                  color="text-emerald-400"
                  sub={
                    recap.personalBest?.isNew
                      ? recap.personalBest.previousBestSec != null
                        ? `${m.recap_new_pb()} · ${formatDelta(recap.personalBest.previousBestSec - recap.bestLapSec)}`
                        : `${m.recap_new_pb()} · ${m.recap_new_pb_first_ever()}`
                      : undefined
                  }
                />
              )}
              <Tile label={m.recap_time_on_track()} value={formatDuration(recap.timeOnTrackSec)} />
              {recap.distanceM != null && <Tile label={m.recap_distance()} value={formatDistance(recap.distanceM)} />}
              {recap.improvementSec != null && <Tile label={m.recap_improvement()} value={`-${recap.improvementSec.toFixed(3)}s`} />}
              {recap.consistency != null && <Tile label={m.recap_consistency()} value={`${recap.consistency.rating}★`} sub={`σ ${recap.consistency.stdDevSec.toFixed(3)}s`} />}
              {recap.theoretical != null && (
                <Tile label={m.recap_theoretical_best()} value={formatLapTime(recap.theoretical.sumSec)} sub={`${recap.theoretical.deltaToBestSec.toFixed(1)}s ${m.recap_left_on_table()}`} />
              )}
            </div>

            {recap.sparkline.length >= 2 && (
              <div>
                <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">{m.recap_pace()}</div>
                <Sparkline laps={recap.sparkline} />
              </div>
            )}
          </div>

          {recap.sectors != null && (
            <div className="lg:w-[240px] shrink-0">
              <SectorTrackMap sectors={recap.sectors} sourceStarts={recap.sectorStarts} outlineData={outlineData} bounds={bounds} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionRecap({ sessionId, gameId: gameIdProp, linkToAnalyse = false }: { sessionId: number; gameId?: GameId | null; linkToAnalyse?: boolean }) {
  const storeGameId = useGameId();
  const gameId = gameIdProp ?? storeGameId;
  const { data: recap, isLoading, isError } = useSessionRecap(sessionId, gameId);
  const { data: outlineData } = useTrackOutline(recap?.trackOrdinal, recap?.gameId ?? gameId);
  const { data: bounds } = useTrackSectorBoundaries(recap?.trackOrdinal, recap?.gameId ?? gameId);
  const [copied, setCopied] = useState(false);
  if (isLoading) return <div className="p-6 text-center text-app-text-dim">{m.common_loading()}</div>;
  if (isError || !recap) return <div className="p-6 text-center text-red-400">{m.common_error()}</div>;
  const copy = () => {
    navigator.clipboard.writeText(buildRecapText(recap)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const analyse = () => {
    if (recap.bestLapId == null) return;
    window.location.href = `${getGameRoute(recap.gameId)}/analyse?track=${recap.trackOrdinal}&car=${recap.carOrdinal}&lap=${recap.bestLapId}`;
  };
  return <SessionRecapView recap={recap} gameId={recap.gameId} linkToAnalyse={linkToAnalyse} copied={copied} onCopy={copy} onAnalyse={analyse} outlineData={outlineData} bounds={bounds} />;
}
