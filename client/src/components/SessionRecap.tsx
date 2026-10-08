import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Cloud, CloudLightning, CloudOff, CloudRain, CloudSun, Flag, Gauge, Sun, Timer } from "lucide-react";
import { m } from "@/paraglide/messages";
import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionRecap as SessionRecapDto } from "@raceiq/shared/racing/sessions/types";
import { useSessionRecap } from "../hooks/session-queries";
import { useTrackOutline, useTrackSectorBoundaries } from "../hooks/track-queries";
import { drawTrack } from "../lib/canvas/draw-track";
import { formatLapTime } from "../lib/format";
import { getGameRoute, useGameId } from "../stores/game";
import { Button } from "./ui/button";
import { getLocale } from "@/paraglide/runtime";
import { parseUtcTimestamp } from "../lib/utc-date";
import { buildRecapText } from "./sessions/helpers";

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
  record: "var(--lap-record)",
  "session-best": "var(--lap-pace-on-target)",
  lost: "var(--lap-pace-off-target)",
};

/** Drawn for a sector we have no status for — must not imply time was lost there. */
const NEUTRAL_SECTOR_COLOR = "var(--app-text-dim)";

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
    <div className="@container">
      <div className="mb-1 text-app-caption uppercase tracking-wider text-app-text-muted">{m.recap_sectors()}</div>
      <div className="grid items-center gap-3 @md:grid-cols-[minmax(0,1fr)_minmax(180px,0.7fr)]">
        {canDraw && <canvas ref={canvasRef} className="h-[220px] w-full" aria-label={m.recap_sectors()} />}
        <div className="flex flex-col gap-1">
          {sectors.map((s) => (
            <div key={s.index} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2 text-xs">
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: SECTOR_COLORS[s.status] }} />
                <span className="font-medium text-app-text-muted">S{s.index}</span>
              </span>
              <span className="whitespace-nowrap font-mono tabular-nums text-app-text/90">{s.bestLapSec.toFixed(3)}</span>
              <span className="whitespace-nowrap text-right text-app-caption text-app-text-dim">{sectorLabel(s.status)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-app-surface-alt/30 p-3 group-data-[compact=true]/recap:p-2">
      <div className="mb-1 min-h-7 break-normal text-app-caption uppercase leading-tight tracking-wider text-app-text-muted group-data-[compact=true]/recap:min-h-0 group-data-[compact=true]/recap:text-app-label">{label}</div>
      <div className={`min-w-0 whitespace-nowrap text-xl font-mono font-black tabular-nums leading-none group-data-[compact=true]/recap:text-app-heading group-data-[compact=true]/recap:font-semibold group-data-[compact=true]/recap:leading-snug ${color ? "" : "text-app-text/90"}`} style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="mt-1 text-app-compact leading-tight text-app-text-dim">{sub}</div>}
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
function compactTrackPoints(outlineData?: TrackOutlineData): { points: { x: number; z: number }[]; viewBox: string } | null {
  const points = (Array.isArray(outlineData) ? outlineData : outlineData?.points ?? []).filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.z),
  );
  if (points.length < 3) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  if (maxX <= minX || maxZ <= minZ) return null;
  return { points, viewBox: `${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}` };
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
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="h-12 w-full overflow-visible" role="img" aria-label={m.recap_pace()}>
      <title>{m.recap_pace()}</title>
      <path d={path} fill="none" stroke="currentColor" className="text-app-accent/50" strokeWidth={1.5} />
      {points.map((p) => (
        <circle key={p.lap.lapId} cx={p.x} cy={p.y} r={p.lap.isValid ? 2 : 2.5} className={p.lap.isValid ? "fill-app-accent" : "fill-status-danger"} />
      ))}
    </svg>
  );
}


export interface SessionRecapViewProps {
  recap: SessionRecapDto;
  gameId: GameId;
  linkToAnalyse?: boolean;
  finishPosition?: number | null;
  showTrackMap?: boolean;
  compact?: boolean;
  sessionType?: string;
  resultClassification?: string | null;
  copied?: boolean;
  onCopy?: () => void;
  onAnalyse?: () => void;
  outlineData?: TrackOutlineData;
  bounds?: TrackSectorBounds;
  carImageUrl?: string;
}
export function SessionRecapView({ recap, gameId, linkToAnalyse = false, finishPosition, showTrackMap = true, compact = false, sessionType, resultClassification, copied = false, onCopy, onAnalyse, outlineData, bounds, carImageUrl }: SessionRecapViewProps) {
  const canAnalyse = linkToAnalyse && gameId === recap.gameId && recap.bestLapId != null && onAnalyse != null;
  const track = compactTrackPoints(outlineData);
  const flipX = !Array.isArray(outlineData) && outlineData?.flipX;
  const typeLabel = sessionType?.trim() && sessionType.trim().toLowerCase() !== "unknown" ? sessionType.trim().replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "—";
  const isRace = /^(race|sprint)/i.test(sessionType?.trim() ?? "");
  const classification = resultClassification?.trim().toLowerCase();
  const finishLabel = classification === "dnf" || classification === "retired" ? "DNF"
    : classification === "disqualified" ? "DSQ"
    : finishPosition != null && Number.isInteger(finishPosition) && finishPosition > 0 ? `P${finishPosition}` : "—";
  const weatherKind = recap.weather?.kind;
  const rainPercent = recap.weather?.rainPercent;
  const wetWithoutKind = rainPercent != null && rainPercent > 0 && (weatherKind == null || weatherKind < 3);
  const weatherLabel = wetWithoutKind ? `${m.f1live_section_weather()} · ${rainPercent}%`
    : weatherKind != null ? [m.f1live_weather_clear(), m.f1live_weather_light_cloud(), m.f1live_weather_overcast(), m.f1live_weather_light_rain(), m.f1live_weather_heavy_rain(), m.f1live_weather_storm()][weatherKind] ?? m.f1live_weather_unknown()
    : m.f1live_weather_unknown();
  const WeatherIcon = wetWithoutKind ? CloudRain : weatherKind === 0 ? Sun : weatherKind === 1 ? CloudSun : weatherKind === 2 ? Cloud : weatherKind === 3 || weatherKind === 4 ? CloudRain : weatherKind === 5 ? CloudLightning : CloudOff;
  return (
    <div data-compact={compact} className={`group/recap @container flex min-w-0 flex-col ${compact ? "recap-cinematic relative isolate gap-3 overflow-hidden" : "gap-4"}`}>
      {compact && carImageUrl && <img aria-hidden="true" src={carImageUrl} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} className="pointer-events-none absolute -right-4 top-0 h-32 w-2/3 object-contain object-right [mask-image:linear-gradient(to_right,transparent,black_35%)] @max-sm:opacity-35" />}
      <div className={`relative flex flex-col gap-3 @sm:flex-row @sm:items-start @sm:justify-between ${compact ? "min-h-20 min-w-0 justify-center @sm:items-center" : ""}`}>
        <div className={`min-w-0 ${compact ? "relative max-w-[65%] @max-sm:max-w-full" : ""}`}>
          {compact ? <>
            <div className="flex items-center gap-3">
              {track && <svg aria-hidden="true" viewBox={track.viewBox} preserveAspectRatio="xMidYMid meet" className="h-12 w-16 shrink-0 overflow-visible text-app-text">{flipX ? <g transform={`translate(${Number(track.viewBox.split(" ")[0]) * 2 + Number(track.viewBox.split(" ")[2])},0) scale(-1,1)`}><polyline points={track.points.map((point) => `${point.x},${point.z}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></g> : <polyline points={track.points.map((point) => `${point.x},${point.z}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />}</svg>}
              <div className="min-w-0 break-words text-xl font-semibold leading-tight text-app-text">{recap.trackName}</div>
            </div>
            <div className="mt-2 flex items-start gap-2 text-app-subtext text-app-text-secondary">
              <span className="shrink-0 rounded border border-app-accent/30 bg-app-accent/10 px-2 py-0.5 text-app-label font-semibold uppercase text-app-accent">{gameId}</span>
              <span className="break-words">{recap.carName}</span>
            </div>
            <div className="mt-2 text-app-label text-app-text-muted">{parseUtcTimestamp(recap.createdAt).toLocaleString(getLocale())} · {typeLabel}</div>
          </> : <>
            <div className="break-words text-base font-bold text-app-text/90">{recap.carName} · {recap.trackName}</div>
            <div className="mt-0.5 text-xs text-app-text-muted">{parseUtcTimestamp(recap.createdAt).toLocaleString(getLocale())}</div>
          </>}
        </div>
        {!compact && <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canAnalyse && (
            <Button variant="app-outline" size="app-sm" onClick={onAnalyse}>
              {m.recap_analyse_best_lap()}
            </Button>
          )}
          {onCopy && (
            <Button variant="app-outline" size="app-sm" onClick={onCopy}>
              {copied ? m.recap_copied() : m.recap_copy()}
            </Button>
          )}
        </div>}
      </div>

      {compact ? (
        <div className="relative flex min-w-0 flex-col gap-3">
          <div className="grid min-w-0 gap-2 @md:grid-cols-[1.65fr_3fr]">
            <div className="recap-best-lap min-w-0 p-2.5">
              <div className="recap-label">{m.recap_best_lap()}</div>
              <div className="recap-best-time mt-2 whitespace-nowrap font-mono font-semibold tabular-nums leading-none">{recap.bestLapSec != null ? formatLapTime(recap.bestLapSec) : "—"}</div>
              {recap.personalBest?.isNew && recap.bestLapSec != null && recap.personalBest.previousBestSec != null && <div className="mt-2 font-mono text-app-subtext tabular-nums text-status-success">{formatDelta(recap.personalBest.previousBestSec - recap.bestLapSec)}</div>}
            </div>
            {recap.sectors?.length ? (
              <div className="grid min-w-0 grid-cols-3 gap-2">
                {recap.sectors.map((sector) => {
                  const fastest = sector.sessionBestSec != null && Math.abs(sector.bestLapSec - sector.sessionBestSec) <= 0.0005;
                  const delta = sector.allTimeBestSec != null ? sector.bestLapSec - sector.allTimeBestSec : null;
                  return <div key={sector.index} className="recap-sector min-w-0 p-2">
                    <div className="recap-label">S{sector.index}</div>
                    <div className={`mt-2 font-mono text-app-heading font-semibold tabular-nums @2xl:text-xl ${fastest ? "text-[var(--lap-record)]" : "text-app-text"}`}>{sector.bestLapSec != null ? sector.bestLapSec.toFixed(3) : "—"}</div>
                    {delta != null && <div title={m.recap_sector_previous_best()} className={`mt-3 font-mono text-app-label tabular-nums ${delta < 0 ? "text-status-success" : delta > 0 ? "text-status-warning" : "text-app-text-muted"}`}>{delta > 0 ? "+" : ""}{delta.toFixed(3)}</div>}
                  </div>;
                })}
              </div>
            ) : <div className="recap-sector flex items-center p-4 text-app-label text-app-text-muted">{m.recap_sectors()} · —</div>}
          </div>
          <div className="recap-footer flex min-w-0 flex-col gap-3 p-2.5 @lg:flex-row @lg:items-center">
            <div className={`grid min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-3 ${isRace ? "@md:grid-cols-4" : "@md:grid-cols-3"}`}>
              <div className="flex min-w-0 items-center gap-2"><Flag aria-hidden="true" className="size-5 shrink-0 text-app-text-muted" /><div><div className="text-app-label text-app-text-muted">{m.recap_laps()}</div><div className="font-mono text-app-subtext font-semibold tabular-nums text-app-text">{recap.lapsValid} / {recap.lapsTotal}</div></div></div>
              <div className="flex min-w-0 items-center gap-2"><Gauge aria-hidden="true" className="size-5 shrink-0 text-app-text-muted" /><div><div className="text-app-label text-app-text-muted">{m.recap_distance()}</div><div className="font-mono text-app-subtext font-semibold tabular-nums text-app-text">{recap.distanceM != null ? formatDistance(recap.distanceM) : "—"}</div></div></div>
              <div className="flex min-w-0 items-center gap-2"><Timer aria-hidden="true" className="size-5 shrink-0 text-app-text-muted" /><div><div className="text-app-label text-app-text-muted">{m.recap_time_on_track()}</div><div className="font-mono text-app-subtext font-semibold tabular-nums text-app-text">{formatDuration(recap.timeOnTrackSec)}</div></div></div>
              {isRace && <div className="min-w-0"><div className="text-app-label text-app-text-muted">Finish</div><div className={`font-mono text-app-heading font-semibold tabular-nums ${finishLabel === "DNF" || finishLabel === "DSQ" ? "text-status-warning" : "text-app-text"}`}>{finishLabel}</div></div>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span role="img" aria-label={weatherLabel} title={weatherLabel} className="text-app-text-secondary"><WeatherIcon aria-hidden="true" className="size-6" /></span>
              {rainPercent != null && <span className="font-mono text-app-label tabular-nums text-app-text-secondary">{m.f1weather_rain_label()} {rainPercent}%</span>}
              {onCopy && <Button variant="app-outline" size="app-md" onClick={onCopy}>{copied ? m.recap_copied() : m.recap_copy()}</Button>}
            </div>
          </div>
        </div>
      ) : recap.lapsTotal === 0 ? (
        <div className="p-6 text-center text-app-text-dim">{m.recap_no_laps()}</div>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid min-w-0 grid-cols-2 gap-2 @lg:grid-cols-4 group-data-[compact=true]/recap:@3xl:grid-cols-6">
            <Tile label={m.recap_laps()} value={`${recap.lapsValid}/${recap.lapsTotal}`} />
            {finishPosition != null && <Tile label="Finish" value={`P${finishPosition}`} />}
            {recap.bestLapSec != null && (
              <Tile
                label={m.recap_best_lap()}
                value={formatLapTime(recap.bestLapSec)}
                color="var(--lap-record)"
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
          {showTrackMap && recap.sectors != null && <SectorTrackMap sectors={recap.sectors} sourceStarts={recap.sectorStarts} outlineData={outlineData} bounds={bounds} />}

          {!compact && recap.sparkline.length >= 2 && (
            <div>
              <div className="mb-1 text-app-caption uppercase tracking-wider text-app-text-muted">{m.recap_pace()}</div>
              <Sparkline laps={recap.sparkline} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionRecap({ sessionId, gameId: gameIdProp, linkToAnalyse = false }: { sessionId: number; gameId?: GameId | null; linkToAnalyse?: boolean }) {
  const navigate = useNavigate();
  const storeGameId = useGameId();
  const gameId = gameIdProp ?? storeGameId;
  const { data: recap, isLoading, isError } = useSessionRecap(sessionId, gameId);
  const { data: outlineData } = useTrackOutline(recap?.trackId, recap?.gameId ?? gameId);
  const { data: bounds } = useTrackSectorBoundaries(recap?.trackId, recap?.gameId ?? gameId);
  const [copied, setCopied] = useState(false);
  if (isLoading)
    return (
      <div role="status" className="p-6 text-center text-app-text-dim">
        {m.common_loading()}
      </div>
    );
  if (isError || !recap)
    return (
      <div role="alert" className="p-6 text-center text-status-danger">
        {m.common_error()}
      </div>
    );
  const copy = () => {
    navigator.clipboard.writeText(buildRecapText(recap)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const analyse = () => {
    if (recap.bestLapId == null) return;
    void navigate({
      to: `${getGameRoute(recap.gameId)}/sessions/${recap.sessionId}/replay/${recap.bestLapId}` as never,
    });
  };
  return <SessionRecapView recap={recap} gameId={recap.gameId} linkToAnalyse={linkToAnalyse} copied={copied} onCopy={copy} onAnalyse={analyse} outlineData={outlineData} bounds={bounds} />;
}
