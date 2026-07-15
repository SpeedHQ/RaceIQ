import { m } from "@/paraglide/messages";
import type { GameId, SessionRecap as SessionRecapDto } from "@shared/types";
import { useState } from "react";
import { useSessionRecap } from "../hooks/queries";
import { formatLapTime } from "../lib/format";
import { useGameId } from "../stores/game";
import { Button } from "./ui/button";

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-3">
      <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-mono font-black tabular-nums leading-none ${color ?? "text-app-text/90"}`}>{value}</div>
      {sub && <div className="text-[11px] text-app-text-dim mt-1">{sub}</div>}
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
  const width = 240;
  const height = 48;
  const pad = 4;
  const times = laps.map((l) => l.lapTimeSec).filter((t) => t > 0);
  if (times.length === 0) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const range = max - min || 1;
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

function buildRecapText(recap: SessionRecapDto): string {
  const lines: string[] = [];
  lines.push(`RaceIQ — ${recap.trackName} · ${recap.carName}`);

  const best = recap.bestLapSec;
  const pb = recap.personalBest;
  const bestPart = best != null ? `${m.recap_text_best()} ${formatLapTime(best)}` : null;
  const pbPart =
    pb?.isNew !== true ? null : pb.previousBestSec != null && best != null ? `${m.recap_new_pb()}, ${formatDelta(pb.previousBestSec - best)}` : `${m.recap_new_pb()}, ${m.recap_new_pb_first_ever()}`;
  const lapsLine = [`${recap.lapsValid} ${m.recap_text_laps()}`, bestPart ? (pbPart ? `${bestPart} (${pbPart})` : bestPart) : null].filter(Boolean).join(" · ");
  if (lapsLine) lines.push(lapsLine);

  if (recap.theoretical != null) {
    lines.push(`${m.recap_text_theoretical()} ${formatLapTime(recap.theoretical.sumSec)} (${recap.theoretical.deltaToBestSec.toFixed(1)}s ${m.recap_left_on_table()})`);
  }

  const tailParts: string[] = [];
  if (recap.consistency != null) tailParts.push(`${m.recap_text_consistency()} ${recap.consistency.rating}★`);
  if (recap.distanceM != null) tailParts.push(formatDistance(recap.distanceM));
  tailParts.push(`${formatDuration(recap.timeOnTrackSec)} ${m.recap_text_on_track()}`);
  if (tailParts.length > 0) lines.push(tailParts.join(" · "));

  return lines.join("\n");
}

/**
 * `gameId` falls back to the active game store, which is only populated inside a
 * per-game layout. The global home page has no game scope, so surfaces there must
 * pass the session's own gameId explicitly.
 */
export function SessionRecap({ sessionId, gameId: gameIdProp }: { sessionId: number; gameId?: GameId | null }) {
  const storeGameId = useGameId();
  const gameId = gameIdProp ?? storeGameId;
  const { data: recap, isLoading, isError } = useSessionRecap(sessionId, gameId);
  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return <div className="p-6 text-center text-app-text-dim">{m.common_loading()}</div>;
  }
  if (isError || !recap) {
    return <div className="p-6 text-center text-red-400">{m.common_error()}</div>;
  }

  const copy = () => {
    navigator.clipboard.writeText(buildRecapText(recap)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-bold text-app-text/90">
            {recap.carName} · {recap.trackName}
          </div>
          <div className="text-xs text-app-text-muted mt-0.5">{new Date(recap.createdAt).toLocaleString()}</div>
        </div>
        <Button
          variant="app-outline"
          size="app-sm"
          onClick={(e) => {
            e.stopPropagation();
            copy();
          }}
        >
          {copied ? m.recap_copied() : m.recap_copy()}
        </Button>
      </div>

      {recap.lapsTotal === 0 ? (
        <div className="p-6 text-center text-app-text-dim">{m.recap_no_laps()}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
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
        </>
      )}
    </div>
  );
}
