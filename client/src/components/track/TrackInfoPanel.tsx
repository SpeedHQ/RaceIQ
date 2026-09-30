import type { ResolvedTrackGuide } from "@shared/racing/tracks/guide/types";
import { segmentDisplayNames, turnNumbers } from "@shared/racing/tracks/segment-label";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-app-border bg-app-surface/50 px-3 py-1.5">
      <span className="text-app-label text-app-text-muted">{label}</span>
      <span className="ml-auto text-app-subtext font-medium text-app-text tabular-nums">{value}</span>
      {hint && <span className="text-app-compact text-app-text-dim">{hint}</span>}
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
  gameId,
  onSegmentHover,
  onSectorHover,
}: {
  track: TrackInfoType;
  sectors: (TrackSectors & { source?: string }) | null;
  sectorBounds: { s1End: number; s2End: number } | null;
  segSource: string;
  gameId?: GameId | null;
  onSegmentHover?: (indices: readonly number[] | null) => void;
  onSectorHover?: (index: number | null) => void;
}) {
  // The expert guide the AI analyst is given for this track, if we have one.
  const { data: guide } = useQuery<ResolvedTrackGuide | null>({
    queryKey: ["track-guide", track.ordinal, gameId ?? null],
    queryFn: () =>
      client.api["track-guide"][":ordinal"]
        .$get({ param: { ordinal: encodeURIComponent(String(track.ordinal)) }, query: { gameId: gameId ?? undefined } } as never)
        .then((r) => r.json() as unknown as ResolvedTrackGuide | null),
    enabled: !!gameId,
    staleTime: 5 * 60 * 1000,
  });

  const segments = sectors?.segments ?? [];
  const labels = useMemo(() => segmentDisplayNames(segments), [segments]);

  const corners = segments.filter((s) => s.type === "corner");
  const straights = segments.filter((s) => s.type === "straight");
  // Turn count is the highest official number the curation covers, not the
  // corner-segment count: a chicane is one segment spanning several turns.
  const turnCount = corners.reduce((max, s) => Math.max(max, ...turnNumbers(s), 0), 0);

  /** Which sector a segment falls in, by its midpoint. */
  const sectorOf = (startFrac: number, endFrac: number): 1 | 2 | 3 => {
    if (!sectorBounds) return 1;
    const mid = (startFrac + endFrac) / 2;
    if (mid < sectorBounds.s1End) return 1;
    if (mid < sectorBounds.s2End) return 2;
    return 3;
  };

  const cornersInSector = (n: 1 | 2 | 3) => corners.filter((s) => sectorOf(s.startFrac, s.endFrac) === n);


  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 @3xl/workspace:grid-cols-3">
        <Stat label={m.trackinfo_length()} value={track.lengthKm > 0 ? `${track.lengthKm} km` : "—"} />
        <Stat label={m.trackinfo_turns()} value={turnCount > 0 ? String(turnCount) : "—"} hint={corners.length > 0 ? m.trackinfo_sections({ n: String(corners.length) }) : undefined} />
        <Stat label={m.trackinfo_straights()} value={straights.length > 0 ? String(straights.length) : "—"} />
      </div>
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
                <div
                  key={n}
                  tabIndex={onSectorHover ? 0 : undefined}
                  onMouseEnter={() => onSectorHover?.(n - 1)}
                  onMouseLeave={() => onSectorHover?.(null)}
                  onFocus={() => onSectorHover?.(n - 1)}
                  onBlur={() => onSectorHover?.(null)}
                  className="rounded-lg border border-app-border bg-app-surface/50 px-3 py-2 hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-app-accent focus-visible:-outline-offset-2"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-app-body font-medium text-app-text">S{n}</span>
                    <span className="text-app-label text-app-text-muted tabular-nums">
                      {(from * 100).toFixed(1)}% – {(to * 100).toFixed(1)}%
                    </span>
                  </div>
                  {within.length > 0 ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-app-label text-app-text-dim">
                      {within.map((s) => (
                        <li key={`${s.startFrac}-${s.endFrac}`}>{labels[segments.indexOf(s)]}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-1 text-app-label text-app-text-dim">{m.trackinfo_no_named_corners()}</div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-app-subtext text-app-text-dim">{m.trackdetail_no_sector_data()}</div>
        )}
      </div>

      {/* Guide — the coaching knowledge the AI analyst is given */}
      {guide && (
        <div>
          <div className="text-app-label text-app-text-muted mb-1.5">{m.trackinfo_guide()}</div>
          <div className="rounded-lg border border-app-border bg-app-surface/50 px-3 py-2">
            <div className="text-app-subtext text-app-text-secondary">{guide.character}</div>
          </div>
          {guide.corners.length > 0 && (
            <div className="mt-2 grid grid-cols-1 gap-2 @5xl/workspace:grid-cols-2">
              {guide.corners.map((c) => {
                const matchingSegments = segments.flatMap((segment, index) =>
                  segment.type === "corner" && turnNumbers(segment).some((number) => c.numbers?.includes(number)) ? [index] : [],
                );
                const canPreview = !!onSegmentHover && matchingSegments.length > 0;
                return (
                  <div
                    key={c.label}
                    tabIndex={canPreview ? 0 : undefined}
                    onMouseEnter={() => onSegmentHover?.(canPreview ? matchingSegments : null)}
                    onMouseLeave={() => onSegmentHover?.(null)}
                    onFocus={() => onSegmentHover?.(canPreview ? matchingSegments : null)}
                    onBlur={() => onSegmentHover?.(null)}
                    className="flex flex-col rounded-lg border border-app-border bg-app-surface/50 px-3 py-2 hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-app-accent focus-visible:-outline-offset-2"
                  >
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
                    <div className="mt-auto pt-2 text-app-label text-app-text-dim">
                      <span className="text-status-warning/80">{m.trackinfo_trap()}</span> {c.trap}
                    </div>
                  </div>
                );
              })}
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
            <TableHeader>
              <TableRow>
                <TableHead>{m.trackinfo_col_section()}</TableHead>
                <TableHead>{m.trackinfo_col_type()}</TableHead>
                <TableHead>{m.trackinfo_col_direction()}</TableHead>
                <TableHead>{m.trackinfo_col_sector()}</TableHead>
                <TableHead>{m.trackinfo_col_lap_position()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((s, i) => (
                <TableRow
                  key={`${s.name}-${s.startFrac}-${s.endFrac}`}
                  tabIndex={onSegmentHover ? 0 : undefined}
                  onMouseEnter={() => onSegmentHover?.([i])}
                  onMouseLeave={() => onSegmentHover?.(null)}
                  onFocus={() => onSegmentHover?.([i])}
                  onBlur={() => onSegmentHover?.(null)}
                  className="focus-visible:outline focus-visible:outline-app-accent focus-visible:-outline-offset-2"
                >
                  <TableCell>
                    <span className={s.type === "corner" ? "text-app-text" : "text-app-text-muted"}>
                      {s.type === "corner" ? "🔶" : "🔷"} {labels[i]}
                    </span>
                  </TableCell>
                  <TableCell className="text-app-text-muted">{s.type === "corner" ? m.trackinfo_type_corner() : m.trackinfo_type_straight()}</TableCell>
                  <TableCell className="text-app-text-muted">{s.direction === "left" ? m.trackinfo_dir_left() : s.direction === "right" ? m.trackinfo_dir_right() : "—"}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-app-text-muted">
                    {sectorBounds ? `S${sectorOf(s.startFrac, s.endFrac)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-app-text-muted">
                    {(s.startFrac * 100).toFixed(1)}% – {(s.endFrac * 100).toFixed(1)}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="text-app-subtext text-app-text-dim">{track.hasOutline ? m.trackinfo_no_segments() : m.trackdetail_no_outline_available()}</div>
        )}
      </div>
    </div>
  );
}
