import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import { isDevelopment } from "@/lib/env";
import { m } from "@/paraglide/messages";
import type { TrackInfo, TrackSectors, TrackSegment } from "../types";

interface TrackDebugSidebarProps {
  track: TrackInfo;
  displaySectors: TrackSectors | null;
  segSource: string;
  editing: boolean;
  editSegments: TrackSegment[];
  saving: boolean;
  sectorBounds: { s1End: number; s2End: number } | null;
  sectorStarts: number[] | null;
  editingSectors: boolean;
  editS1: number;
  editS2: number;
  savingSectors: boolean;
  segDisplayNames: string[];
  startEditing: () => void;
  saveSegments: () => void;
  toggleSegType: (index: number) => void;
  addSegment: (index: number) => void;
  removeSegment: (index: number) => void;
  updateSegFrac: (index: number, field: "startFrac" | "endFrac", value: number) => void;
  setEditing: (editing: boolean) => void;
  startEditingSectors: () => void;
  saveSectorBounds: () => void;
  setEditingSectors: (editing: boolean) => void;
  setEditS1: (value: number) => void;
  setEditS2: (value: number) => void;
}

export function TrackDebugSidebar(props: TrackDebugSidebarProps) {
  const {
    track,
    displaySectors,
    segSource,
    editing,
    editSegments,
    saving,
    sectorBounds,
    sectorStarts,
    editingSectors,
    editS1,
    editS2,
    savingSectors,
    segDisplayNames,
    startEditing,
    saveSegments,
    toggleSegType,
    addSegment,
    removeSegment,
    updateSegFrac,
    setEditing,
    startEditingSectors,
    saveSectorBounds,
    setEditingSectors,
    setEditS1,
    setEditS2,
  } = props;
  return (
    <div className="w-80 shrink-0 flex flex-col gap-3 overflow-auto">
      {/* Segment list / editor */}
      {displaySectors && displaySectors.segments.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-app-label text-app-text-muted uppercase tracking-wider">{m.track_detail_segments()}</span>
              {segSource && <span className="text-app-micro font-mono text-app-text-dim px-1 py-0.5 rounded bg-app-surface-alt border border-app-border-input">{segSource}</span>}
            </div>
            {isDevelopment &&
              (!editing ? (
                <Button type="button" onClick={startEditing} className="text-app-compact text-app-accent hover:text-app-accent-hover px-2 py-0.5 rounded bg-app-accent/10 border border-app-accent/30">
                  {m.common_edit()}
                </Button>
              ) : (
                <div className="flex gap-1">
                  <Button
                    type="button"
                    onClick={saveSegments}
                    disabled={saving}
                    className="text-app-compact text-status-success px-2 py-0.5 rounded bg-status-success/10 border border-status-success/30 hover:bg-status-success/20 disabled:opacity-50"
                  >
                    {saving ? "..." : m.common_save()}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="text-app-compact text-app-text-secondary hover:text-app-text px-2 py-0.5 rounded bg-app-surface-alt border border-app-border-input"
                  >
                    {m.common_cancel()}
                  </Button>
                </div>
              ))}
          </div>
          <div className="flex flex-col gap-0.5 max-h-[300px] overflow-auto">
            {(editing ? editSegments : displaySectors.segments).map((seg, i) => {
              const pct = ((seg.endFrac - seg.startFrac) * 100).toFixed(1);
              const isCorner = seg.type === "corner";
              const color = isCorner ? "var(--track-corner-overlay)" : "var(--track-straight-overlay)";
              const colorStyle = { ["--segment-color" as string]: color };
              if (!editing) {
                return (
                  <div key={`${seg.startFrac}-${seg.endFrac}`} className="flex items-center justify-between px-2 py-1 rounded bg-(--segment-color)/10" style={colorStyle}>
                    <div className="flex items-center gap-2">
                      <span className="text-app-label font-mono font-bold text-(--segment-color)">{segDisplayNames[i]}</span>
                      <span className="text-app-label text-app-text-muted capitalize">{seg.type}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {track.lengthKm > 0 && <span className="text-app-label font-mono text-app-text-dim">{((seg.endFrac - seg.startFrac) * track.lengthKm).toFixed(2)} km</span>}
                      <span className="text-app-label font-mono text-app-text-secondary">{pct}%</span>
                    </div>
                  </div>
                );
              }
              return (
                <div key={`${seg.startFrac}-${seg.endFrac}`} className="px-2 py-1.5 rounded space-y-1 bg-(--segment-color)/10" style={colorStyle}>
                  <div className="flex items-center gap-1">
                    <Button type="button" onClick={() => toggleSegType(i)} className="shrink-0 text-app-compact font-bold px-1 rounded bg-(--segment-color)/20 text-(--segment-color)">
                      {isCorner ? "T" : "S"}
                    </Button>
                    <span className="flex-1 min-w-0 truncate text-app-label font-mono font-bold text-(--segment-color)" title={m.trackdetail_segment_name_readonly()}>
                      {segDisplayNames[i]}
                    </span>
                    <Button
                      type="button"
                      onClick={() => addSegment(i)}
                      className="shrink-0 w-5 h-5 flex items-center justify-center text-app-compact rounded bg-app-surface-alt border border-app-border-input text-app-text-muted hover:text-app-text"
                      title={m.trackdetail_split_segment()}
                    >
                      +
                    </Button>
                    <Button
                      type="button"
                      onClick={() => removeSegment(i)}
                      disabled={(editing ? editSegments : displaySectors.segments).length <= 1}
                      className="shrink-0 w-5 h-5 flex items-center justify-center text-app-compact rounded bg-status-danger/10 border border-status-danger/30 text-status-danger hover:bg-status-danger/20 disabled:opacity-30"
                      title={m.trackdetail_remove_segment()}
                    >
                      ×
                    </Button>
                  </div>
                  <div className="flex items-center gap-2 text-app-label font-mono text-app-text-secondary">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      value={(seg.startFrac * 100).toFixed(1)}
                      onChange={(e) => updateSegFrac(i, "startFrac", Number(e.target.value) / 100)}
                      className="w-14 bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center"
                    />
                    <span>-</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      value={(seg.endFrac * 100).toFixed(1)}
                      onChange={(e) => updateSegFrac(i, "endFrac", Number(e.target.value) / 100)}
                      className="w-14 bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center"
                    />
                    <span className="text-app-text-dim">({pct}%)</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
      {/* Sector Boundaries */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider">{m.trackdetail_sector_boundaries()}</div>
          {isDevelopment &&
            sectorBounds &&
            (!editingSectors ? (
              <Button
                type="button"
                onClick={startEditingSectors}
                disabled={!sectorBounds}
                className="text-app-compact text-app-accent hover:text-app-accent-hover px-2 py-0.5 rounded bg-app-accent/10 border border-app-accent/30 disabled:opacity-50"
              >
                {m.common_edit()}
              </Button>
            ) : (
              <div className="flex gap-1">
                <Button
                  type="button"
                  onClick={saveSectorBounds}
                  disabled={savingSectors}
                  className="text-app-compact text-status-success px-2 py-0.5 rounded bg-status-success/10 border border-status-success/30 hover:bg-status-success/20 disabled:opacity-50"
                >
                  {savingSectors ? "..." : m.common_save()}
                </Button>
                <Button
                  type="button"
                  onClick={() => setEditingSectors(false)}
                  className="text-app-compact text-app-text-secondary hover:text-app-text px-2 py-0.5 rounded bg-app-surface-alt border border-app-border-input"
                >
                  {m.common_cancel()}
                </Button>
              </div>
            ))}
        </div>
        {editingSectors && sectorBounds ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: SECTOR_COLOR_VARS[0] }} />
              <span className="text-app-label text-app-text-muted w-16">{m.trackdetail_s1_end()}</span>
              <input
                type="number"
                step="0.1"
                min="1"
                max={editS2 - 1}
                value={editS1.toFixed(1)}
                onChange={(e) => setEditS1(Number(e.target.value))}
                className="w-16 text-app-label font-mono bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center"
              />
              <span className="text-app-label text-app-text-dim">%</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: SECTOR_COLOR_VARS[1] }} />
              <span className="text-app-label text-app-text-muted w-16">{m.trackdetail_s2_end()}</span>
              <input
                type="number"
                step="0.1"
                min={editS1 + 1}
                max="99"
                value={editS2.toFixed(1)}
                onChange={(e) => setEditS2(Number(e.target.value))}
                className="w-16 text-app-label font-mono bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center"
              />
              <span className="text-app-label text-app-text-dim">%</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: SECTOR_COLOR_VARS[2] }} />
              <span className="text-app-label text-app-text-muted w-16">{m.trackdetail_s3_end()}</span>
              <span className="text-app-label font-mono text-app-text-secondary">100.0</span>
              <span className="text-app-label text-app-text-dim">% ({m.trackdetail_finish()})</span>
            </div>
            <div className="flex h-2 rounded overflow-hidden mt-1">
              <div style={{ backgroundColor: SECTOR_COLOR_VARS[0], opacity: 0.6, width: `${editS1}%` }} />
              <div style={{ backgroundColor: SECTOR_COLOR_VARS[1], opacity: 0.6, width: `${editS2 - editS1}%` }} />
              <div style={{ backgroundColor: SECTOR_COLOR_VARS[2], opacity: 0.6, width: `${100 - editS2}%` }} />
            </div>
          </div>
        ) : sectorStarts ? (
          <div className="space-y-1">
            {sectorStarts.map((start, index) => {
              const from = index === 0 ? 0 : start;
              const fraction = (sectorStarts[index + 1] ?? 1) - from;
              const color = SECTOR_COLOR_VARS[index % SECTOR_COLOR_VARS.length];
              return (
                <div key={index} className="flex items-center gap-2 px-2 py-1 rounded bg-app-surface-alt/30">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-app-label font-mono font-bold text-app-text">S{index + 1}</span>
                  {track.lengthKm > 0 && <span className="text-app-label font-mono text-app-text-dim">{(fraction * track.lengthKm).toFixed(2)} km</span>}
                  <span className="text-app-label font-mono text-app-text-secondary ml-auto">{(fraction * 100).toFixed(1)}%</span>
                </div>
              );
            })}
            <div className="flex h-2 rounded overflow-hidden mt-1">
              {sectorStarts.map((start, index) => {
                const from = index === 0 ? 0 : start;
                const fraction = (sectorStarts[index + 1] ?? 1) - from;
                return (
                  <div
                    key={index}
                    style={{
                      backgroundColor: SECTOR_COLOR_VARS[index % SECTOR_COLOR_VARS.length],
                      opacity: 0.6,
                      width: `${fraction * 100}%`,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          <div className="text-app-label text-app-text-dim">{m.trackdetail_no_sector_data()}</div>
        )}
      </Card>
    </div>
  );
}
