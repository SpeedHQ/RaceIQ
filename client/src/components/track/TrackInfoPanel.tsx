import type { ResolvedTrackGuide } from "@shared/racing/tracks/guide/types";
import { lapWrappedSegmentGroup, logicalSegmentCounts, segmentDisplayNames, turnNumbers } from "@shared/racing/tracks/segment-label";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { countryName } from "@/lib/country-names";
import { useUnits } from "@/hooks/useUnits";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import type { GameId } from "../../../../shared/games/ids";
import type { TrackInfo as TrackInfoType, TrackSectors } from "./types";

/**
 * The track's reference data, gathered in one place: what the circuit is, how
 * it's split, and which of it we actually hold.
 *
 * The corner names and turn numbers here are the same curated data the AI
 * analyst is given and the track map draws, so this doubles as the way to see
 * what the coach knows about a track before asking it anything.
 */

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-app-border bg-app-surface/50 px-3 py-2">
      <div className="text-app-label text-app-text-muted">{label}</div>
      <div className="text-app-body font-medium text-app-text tabular-nums">{value}</div>
      {hint && <div className="text-app-label text-app-text-dim">{hint}</div>}
    </div>
  );
}

/** Curated vs auto-detected. Worth stating plainly — they aren't equivalent. */
function SourceBadge({ source }: { source: string }) {
  const curated = source === "shared";
  return (
    <span
      className={`text-app-caption px-1.5 py-0.5 rounded border font-mono leading-none ${
        curated ? "bg-status-success/15 border-status-success/50 text-status-success" : "bg-app-surface-alt/70 border-app-border text-app-text-dim"
      }`}
    >
      {curated ? m.trackinfo_source_curated() : m.trackinfo_source_auto()}
    </span>
  );
}

export function TrackInfoPanel({
  track,
  sectors,
  sectorBounds,
  segSource,
  lapCount,
  gameId,
  part = "summary",
}: {
  track: TrackInfoType;
  sectors: (TrackSectors & { source?: string }) | null;
  sectorBounds: { s1End: number; s2End: number } | null;
  segSource: string;
  lapCount: number;
  gameId?: GameId | null;
  /**
   * "summary" sits beside the map in the top row, like the laps leaderboard;
   * "details" is the full-width reading below it.
   */
  part?: "summary" | "details";
}) {
  // The expert guide the AI analyst is given for this track, if we have one.
  const { data: guide } = useQuery<ResolvedTrackGuide | null>({
    queryKey: ["track-guide", track.ordinal, gameId ?? null],
    queryFn: () =>
      client.api["track-guide"][":ordinal"]
        .$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gameId ?? undefined } } as never)
        .then((r) => r.json() as unknown as ResolvedTrackGuide | null),
    enabled: !!gameId,
    staleTime: 5 * 60 * 1000,
  });

  const units = useUnits();
  const segments = sectors?.segments ?? [];
  const lapWrap = useMemo(() => lapWrappedSegmentGroup(segments), [segments]);
  const displayedSegments = useMemo(
    () => segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ index }) => index !== lapWrap?.lastIndex),
    [segments, lapWrap],
  );
  const labels = useMemo(() => segmentDisplayNames(segments), [segments, lapWrap]);

  const corners = segments.filter((s) => s.type === "corner");
  // Turn count is highest official number curation covers; fallback native catalog count.
  const turnCount = corners.reduce((max, s) => Math.max(max, ...turnNumbers(s), 0), 0);
  const displayedTurnCount = turnCount || track.cornersPerLap || 0;
  const {
    corners: displayedCornerSections,
    straights: displayedStraights,
  } = logicalSegmentCounts(segments);
  /** Which sector a segment falls in, by its midpoint. */
  const sectorOf = (startFrac: number, endFrac: number): 1 | 2 | 3 => {
    if (!sectorBounds) return 1;
    const mid = (startFrac + endFrac) / 2;
    if (mid < sectorBounds.s1End) return 1;
    if (mid < sectorBounds.s2End) return 2;
    return 3;
  };

  const cornersInSector = (n: 1 | 2 | 3) => corners.filter((s) => sectorOf(s.startFrac, s.endFrac) === n);

  if (part === "summary") {
    return (
      <div className="space-y-3">
        {/* What the circuit is */}
        <div>
          <div className="text-app-body font-medium text-app-text">{track.name}</div>
          <div className="text-app-label text-app-text-muted">
            {[track.variant, track.location && `${track.location}${track.country ? `, ${countryName(track.country)}` : ""}`].filter(Boolean).join(" · ")}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Stat label={m.trackinfo_length()} value={track.lengthKm > 0 ? `${track.lengthKm} km` : "—"} />
          <Stat
            label={m.trackinfo_turns()}
            value={displayedTurnCount > 0 ? String(displayedTurnCount) : "—"}
            hint={
              corners.length > 0
                ? m.trackinfo_sections({ n: String(displayedCornerSections) })
                : displayedTurnCount > 0
                  ? m.trackinfo_official_layout_data()
                  : undefined
            }
          />
          {gameId === "iracing" && track.pitRoadSpeedLimitMph != null && (
            <Stat
              label={m.trackinfo_pit_speed()}
              value={`${Math.round(units.fromMph(track.pitRoadSpeedLimitMph))} ${units.speedLabel}`}
            />
          )}
          {gameId === "iracing" && track.maxCars != null && track.maxCars > 0 && (
            <Stat label={m.trackinfo_max_cars()} value={String(track.maxCars)} />
          )}
          <Stat label={m.trackinfo_straights()} value={displayedStraights > 0 ? String(displayedStraights) : "—"} />
          <Stat label={m.trackinfo_laps_recorded()} value={String(lapCount)} />
        </div>
        {gameId === "iracing" &&
          (track.rainEnabled ||
            track.nightLighting ||
            (track.numberPitStalls != null && track.numberPitStalls > 0)) && (
            <div className="flex flex-wrap gap-1">
              {track.rainEnabled && <span className="rounded border border-app-border bg-app-surface-alt px-1.5 py-0.5 text-app-caption text-app-text-muted">{m.trackinfo_rain_racing()}</span>}
              {track.nightLighting && <span className="rounded border border-app-border bg-app-surface-alt px-1.5 py-0.5 text-app-caption text-app-text-muted">{m.trackinfo_night_racing()}</span>}
              {track.numberPitStalls != null && track.numberPitStalls > 0 && <span className="rounded border border-app-border bg-app-surface-alt px-1.5 py-0.5 text-app-caption text-app-text-muted">{m.trackinfo_pit_stalls({ n: String(track.numberPitStalls) })}</span>}
            </div>
          )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Sectors */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <div className="text-app-label text-app-text-muted">{m.trackdetail_sector_boundaries()}</div>
        </div>
        {sectorBounds ? (
          <div className="grid grid-cols-1 gap-2 @3xl/workspace:grid-cols-3">
            {([1, 2, 3] as const).map((n) => {
              const from = n === 1 ? 0 : n === 2 ? sectorBounds.s1End : sectorBounds.s2End;
              const to = n === 1 ? sectorBounds.s1End : n === 2 ? sectorBounds.s2End : 1;
              const within = cornersInSector(n);
              return (
                <div key={n} className="rounded-lg border border-app-border bg-app-surface/50 px-3 py-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-app-body font-medium text-app-text">S{n}</span>
                    <span className="text-app-label text-app-text-muted tabular-nums">
                      {(from * 100).toFixed(1)}% – {(to * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-app-label text-app-text-dim mt-0.5">{within.length > 0 ? within.map((s) => labels[segments.indexOf(s)]).join(", ") : m.trackinfo_no_named_corners()}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-app-subtext text-app-text-dim">{m.trackdetail_no_sector_data()}</div>
        )}
      </div>

      {/* Expert guide — the coaching knowledge the AI analyst is given */}
      {guide && (
        <div>
          <div className="text-app-label text-app-text-muted mb-1.5">{m.trackinfo_guide()}</div>
          <div className="rounded-lg border border-app-border bg-app-surface/50 px-3 py-2">
            <div className="text-app-subtext text-app-text-secondary">{guide.character}</div>
          </div>
          {guide.corners.length > 0 && (
            <div className="mt-2 grid grid-cols-1 gap-2 @5xl/workspace:grid-cols-2">
              {guide.corners.map((c) => (
                <div key={c.label} className="rounded-lg border border-app-border bg-app-surface/50 px-3 py-2">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-app-body font-medium text-app-text">{c.label}</span>
                    {c.priority && (
                      <span className="text-app-caption px-1.5 py-0.5 rounded border font-mono leading-none bg-status-warning/15 border-status-warning/50 text-status-warning">
                        {m.trackinfo_priority()}
                      </span>
                    )}
                    <span className="text-app-label text-app-text-dim">{c.type}</span>
                  </div>
                  <div className="text-app-subtext text-app-text-secondary mt-1">{c.technique}</div>
                  <div className="text-app-label text-app-text-dim mt-0.5">
                    <span className="text-status-warning/80">{m.trackinfo_trap()}</span> {c.trap}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Segments */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <div className="text-app-label text-app-text-muted">{m.track_detail_segments()}</div>
          {segments.length > 0 && <SourceBadge source={segSource} />}
        </div>
        {segments.length > 0 ? (
          <Table>
            {/* THead owns its row; pass header cells directly. */}
            <THead>
              <TH>{m.trackinfo_col_section()}</TH>
              <TH>{m.trackinfo_col_type()}</TH>
              <TH>{m.trackinfo_col_direction()}</TH>
              <TH>{m.trackinfo_col_sector()}</TH>
              <TH>{m.trackinfo_col_lap_position()}</TH>
            </THead>
            <TBody>
              {displayedSegments.map(({ segment: s, index: i }) => {
                const wrapped =
                  lapWrap?.firstIndex === i ? segments[lapWrap.lastIndex] : undefined;
                const segmentSectors = sectorBounds
                  ? [...new Set([...(wrapped ? [wrapped] : []), s].map((member) => `S${sectorOf(member.startFrac, member.endFrac)}`))].join("/")
                  : "—";
                const lapPosition = wrapped
                  ? `${(wrapped.startFrac * 100).toFixed(1)}% – 100.0% + 0.0% – ${(s.endFrac * 100).toFixed(1)}%`
                  : `${(s.startFrac * 100).toFixed(1)}% – ${(s.endFrac * 100).toFixed(1)}%`;
                return (
                  <TRow key={`${s.type}-${s.group ?? s.name}-${s.startFrac}`}>
                    <TD>
                      <span className={s.type === "corner" ? "text-app-text" : "text-app-text-muted"}>
                        {s.type === "corner" ? "🔶" : "🔷"} {labels[i]}
                      </span>
                    </TD>
                    <TD tone="muted">{s.type === "corner" ? m.trackinfo_type_corner() : m.trackinfo_type_straight()}</TD>
                    <TD tone="muted">{s.direction === "left" ? m.trackinfo_dir_left() : s.direction === "right" ? m.trackinfo_dir_right() : "—"}</TD>
                    <TD numeric tone="muted">{segmentSectors}</TD>
                    <TD numeric tone="muted">{lapPosition}</TD>
                  </TRow>
                );
              })}
            </TBody>
          </Table>
        ) : (
          <div className="text-app-subtext text-app-text-dim">{track.hasOutline ? m.trackinfo_no_segments() : m.trackdetail_no_outline_available()}</div>
        )}
      </div>
    </div>
  );
}
