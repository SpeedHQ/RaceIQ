import { m } from "@/paraglide/messages";
import type { GameId, SessionRecap as SessionRecapDto } from "@shared/types";
import { useState } from "react";
import { useSessionRecap } from "../hooks/queries";
import { formatLapTime } from "../lib/format";
import { getGameRoute, useGameId } from "../stores/game";
import { Button } from "./ui/button";

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
 *
 * `linkToAnalyse` adds an "Analyse best lap" action. Surfaces that render this
 * inline (the home card) use it; the modal does not, since it is already opened
 * from a list that can navigate on its own.
 */
function dialCircumference() {
  return 2 * Math.PI * 26;
}

function Dial({ value, pct, label, color }: { value: string; pct: number; label: string; color: string }) {
  const C = dialCircumference();
  const off = C * (1 - Math.max(0, Math.min(1, pct)));
  return (
    <div className="text-center">
      <svg width={66} height={66} viewBox="0 0 66 66" className="mx-auto block" aria-hidden="true">
        <circle cx={33} cy={33} r={26} fill="none" stroke="#222b37" strokeWidth={6} />
        <circle cx={33} cy={33} r={26} fill="none" stroke={color} strokeWidth={6} strokeDasharray={C} strokeDashoffset={off} strokeLinecap="round" transform="rotate(-90 33 33)" />
        <text x={33} y={38} textAnchor="middle" fill="#eaf0f7" fontFamily="monospace" fontSize={14} fontWeight={700}>
          {value}
        </text>
      </svg>
      <div className="mt-1.5 font-mono text-[9px] uppercase tracking-wider text-app-text-muted">{label}</div>
    </div>
  );
}

function RichStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-app-border bg-white/[0.02] px-2.5 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-app-text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-semibold text-app-text">{value}</div>
    </div>
  );
}

/** Build a 10-bin lap-time histogram from valid lap times. Null when too few laps. */
function buildDistribution(times: number[], bestSec: number | null) {
  if (times.length < 3) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = max - min || 1;
  const nb = 10;
  const counts = new Array(nb).fill(0);
  for (const t of times) {
    const bi = Math.min(nb - 1, Math.floor(((t - min) / span) * nb));
    counts[bi]++;
  }
  const maxC = Math.max(...counts, 1);
  const bestBin = bestSec != null ? Math.min(nb - 1, Math.max(0, Math.floor(((bestSec - min) / span) * nb))) : -1;
  return counts.map((c, i) => {
    const h = c > 0 ? 4 + (c / maxC) * 36 : 3;
    return { x: 4 + i * 32, y: 44 - h, h, best: i === bestBin };
  });
}

export function SessionRecap({
  sessionId,
  gameId: gameIdProp,
  linkToAnalyse = false,
}: {
  sessionId: number;
  gameId?: GameId | null;
  linkToAnalyse?: boolean;
}) {
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

  // Only offer analysis when there is a valid lap to analyse.
  const analyseHref = linkToAnalyse && recap.bestLapId != null ? `${getGameRoute(recap.gameId)}/analyse?track=${recap.trackOrdinal}&car=${recap.carOrdinal}&lap=${recap.bestLapId}` : null;

  const consistPct = recap.consistency ? recap.consistency.rating / 5 : 0;
  const cleanPct = recap.lapsTotal > 0 ? recap.lapsValid / recap.lapsTotal : 0;
  const avgLapSec = recap.lapsValid > 0 ? recap.timeOnTrackSec / recap.lapsValid : null;
  const validTimes = recap.sparkline.filter((l) => l.isValid).map((l) => l.lapTimeSec);
  const distBars = buildDistribution(validTimes, recap.bestLapSec);
  const bestStr = recap.bestLapSec != null ? formatLapTime(recap.bestLapSec) : null;
  const dotIdx = bestStr != null ? bestStr.lastIndexOf(".") : -1;
  const bestMain = bestStr != null && dotIdx >= 0 ? bestStr.slice(0, dotIdx) : bestStr;
  const bestFrac = bestStr != null && dotIdx >= 0 ? bestStr.slice(dotIdx) : "";

  return (
    <div className="relative flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold tracking-tight text-app-text">{recap.trackName}</h2>
          <div className="mt-0.5 font-mono text-xs text-app-text-muted">{recap.carName}</div>
        </div>
        <Button variant="app-outline" size="app-sm" onClick={copy}>
          {copied ? m.recap_copied() : m.recap_copy()}
        </Button>
      </div>

      {recap.lapsTotal === 0 ? (
        <div className="p-6 text-center text-app-text-dim">{m.recap_no_laps()}</div>
      ) : (
        <>
          <div className="mt-5 mb-1 flex items-start justify-between">
            <Dial value={recap.consistency ? `${Math.round(consistPct * 100)}%` : "—"} pct={consistPct} label={m.recap_consistency()} color="var(--color-app-accent-2, #28e0a8)" />
            <Dial value={`${recap.lapsValid}`} pct={cleanPct} label={m.recap_laps()} color="var(--color-app-highlight, #4ec9ff)" />
            <Dial value={`${Math.round(cleanPct * 100)}%`} pct={cleanPct} label="Clean" color="var(--color-app-accent, #7c5cff)" />
          </div>

          <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">{m.recap_best_lap()}</div>
          {bestStr != null ? (
            <>
              <div className="font-mono text-[44px] font-bold leading-none tracking-tight text-app-text">
                {bestMain}
                <span className="text-lg text-app-text-muted">{bestFrac}</span>
              </div>
              {recap.personalBest?.isNew && (
                <div className="mt-1.5 font-mono text-xs text-app-accent-2">
                  {"▲ "}
                  {m.recap_new_pb()}
                  {recap.personalBest.previousBestSec != null && recap.bestLapSec != null ? ` · ${formatDelta(recap.personalBest.previousBestSec - recap.bestLapSec)}` : ""}
                </div>
              )}
            </>
          ) : (
            <div className="font-mono text-2xl text-app-text-muted">—</div>
          )}

          {recap.sectors && (
            <div className="mt-4 grid grid-cols-3 gap-2">
              {recap.sectors.map((s) => (
                <div key={s.index} className="rounded-lg border border-app-border bg-white/[0.03] p-2 text-center">
                  <div className="font-mono text-[9px] tracking-[0.1em] text-app-text-muted">S{s.index}</div>
                  <div className={`mt-0.5 font-mono text-sm font-semibold ${s.status !== "lost" ? "text-app-accent-2" : "text-app-text"}`}>{s.bestLapSec.toFixed(3)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 grid grid-cols-3 gap-2">
            <RichStat label="Avg lap" value={avgLapSec != null ? formatLapTime(avgLapSec) : "—"} />
            <RichStat label="Clean" value={`${recap.lapsValid}/${recap.lapsTotal}`} />
            <RichStat label={m.recap_distance()} value={recap.distanceM != null ? formatDistance(recap.distanceM) : "—"} />
          </div>

          {recap.sparkline.length >= 2 && (
            <div className="mt-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">{m.recap_pace()}</div>
              <Sparkline laps={recap.sparkline} />
            </div>
          )}

          {distBars && (
            <div className="mt-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">Lap-time distribution</div>
              <svg viewBox="0 0 340 44" preserveAspectRatio="none" className="mt-1.5 h-11 w-full" aria-hidden="true">
                {distBars.map((b) => (
                  <rect key={`${b.x}-${b.h}`} x={b.x} y={b.y} width={26} height={b.h} fill={b.best ? "var(--color-app-accent-2, #28e0a8)" : "#2a3444"} />
                ))}
              </svg>
            </div>
          )}

          {analyseHref && (
            <button
              type="button"
              onClick={() => {
                window.location.href = analyseHref;
              }}
              className="mt-4 w-full rounded-[10px] border border-app-accent bg-app-accent/15 py-2.5 font-mono text-xs tracking-[0.06em] text-app-text transition-colors hover:bg-app-accent/25"
            >
              {m.recap_analyse_best_lap()} →
            </button>
          )}
        </>
      )}
    </div>
  );
}
