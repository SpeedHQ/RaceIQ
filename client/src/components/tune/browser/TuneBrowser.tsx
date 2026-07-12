import { useMemo, useState } from "react";
import { ComboBox, type ComboOption } from "./ComboBox";
import { TuneBrowserRow } from "./TuneBrowserRow";
import type { SourceTab, TuneRow } from "./types";

export interface TuneBrowserProps {
  title: string;
  rows: TuneRow[];
  trackOptions: ComboOption[];
  carOptions: ComboOption[];
  sources: SourceTab[];
  onClone: (row: TuneRow) => void;
  onEdit: (row: TuneRow) => void;
  onDelete: (row: TuneRow) => void;
  onNewTune: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function TuneBrowser(props: TuneBrowserProps) {
  const { rows, trackOptions, carOptions, sources } = props;
  const [track, setTrack] = useState("any");
  const [car, setCar] = useState("any");
  const [source, setSource] = useState<SourceTab["key"]>("all");
  const [sortAsc, setSortAsc] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const visible = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (track !== "any" && r.trackOrdinal !== Number(track)) return false;
      if (car !== "any" && r.carOrdinal !== Number(car)) return false;
      if (source !== "all" && r.source !== source) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const ta = a.lapTimeSec ?? Number.POSITIVE_INFINITY;
      const tb = b.lapTimeSec ?? Number.POSITIVE_INFINITY;
      if (ta === tb) return 0;
      return sortAsc ? ta - tb : tb - ta;
    });
    return filtered;
  }, [rows, track, car, source, sortAsc]);

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-bold text-app-text">{props.title}</h1>
        <button type="button" onClick={props.onNewTune} className="text-xs font-semibold px-4 py-2 rounded bg-app-accent text-white">
          + New tune
        </button>
      </div>

      <div className="flex items-end gap-3">
        <ComboBox
          label="1 · Track"
          value={track}
          options={trackOptions}
          onChange={(v) => {
            setTrack(v);
          }}
          placeholder="Any track"
        />
        <span className="text-app-text-muted pb-3">→</span>
        <ComboBox
          label="2 · Car"
          value={car}
          options={carOptions}
          onChange={(v) => {
            setCar(v);
          }}
          placeholder="Any car"
        />
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {sources.map((s) => (
          <button
            type="button"
            key={s.key}
            onClick={() => setSource(s.key)}
            className={`text-[10px] font-semibold uppercase px-2.5 py-1.5 rounded border transition-colors ${source === s.key ? "border-app-accent text-app-accent" : "border-app-border text-app-text-muted hover:text-app-text-secondary"}`}
          >
            {s.label}
          </button>
        ))}
        <div className="flex-1" />
        {props.onRefresh && (
          <button
            type="button"
            onClick={props.onRefresh}
            disabled={props.refreshing}
            className="text-[10px] font-semibold uppercase px-2 py-1.5 text-app-text-muted hover:text-app-text-secondary disabled:opacity-50"
          >
            {props.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>

      <div className="rounded-lg overflow-hidden border border-app-border">
        <div className="grid grid-cols-[32px_1fr_minmax(120px,150px)_96px_92px_20px] items-center gap-3 px-3 py-2.5 bg-app-bg text-[9px] tracking-wider text-app-text-muted uppercase">
          <span>#</span>
          <span>Tune</span>
          <span>Author</span>
          <span className="justify-self-end">Category</span>
          <button type="button" onClick={() => setSortAsc((a) => !a)} className="justify-self-end uppercase text-app-accent">
            Lap time {sortAsc ? "▲" : "▼"}
          </button>
          <span />
        </div>
        <div className="space-y-2 p-2">
          {visible.map((row, i) => (
            <TuneBrowserRow
              key={row.key}
              row={row}
              rank={i + 1}
              isOpen={openKey === row.key}
              onToggle={() => setOpenKey(openKey === row.key ? null : row.key)}
              onClone={props.onClone}
              onEdit={props.onEdit}
              onDelete={props.onDelete}
            />
          ))}
          {visible.length === 0 && <div className="text-center py-12 text-app-text-muted text-sm">No tunes match this filter.</div>}
        </div>
      </div>
      <p className="text-[10px] text-app-text-muted">↕ Sort by lap time · pick a track to compare (times only compare within one track).</p>
    </div>
  );
}
