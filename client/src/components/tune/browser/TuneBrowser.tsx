import { useMemo, useRef, useState } from "react";
import { ComboBox, type ComboOption } from "./ComboBox";
import { TuneBrowserRow } from "./TuneBrowserRow";
import type { SourceTab, TuneRow } from "./types";

export interface TuneBrowserProps {
  title: string;
  subtitle?: string;
  rows: TuneRow[];
  trackOptions: ComboOption[];
  carOptions: ComboOption[];
  sources: SourceTab[];
  onClone: (row: TuneRow) => void;
  onEdit: (row: TuneRow) => void;
  onDelete: (row: TuneRow) => void;
  onNewTune: () => void;
  onImportFile?: (file: File) => void;
  importing?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}

const PAGE_SIZE = 10;
const GRID = "grid grid-cols-[26px_1fr_66px_26px] sm:grid-cols-[34px_1fr_minmax(120px,160px)_96px_92px_30px] items-center gap-2.5";

// Active-tab colouring per source.
const TAB_ACTIVE: Record<string, string> = {
  all: "border-app-accent text-app-accent",
  builtin: "border-amber-500 text-amber-500",
  community: "border-pink-400 text-pink-400",
  user: "border-emerald-400 text-emerald-400",
};

export function TuneBrowser(props: TuneBrowserProps) {
  const { rows, trackOptions, carOptions, sources } = props;
  const [track, setTrack] = useState("any");
  const [car, setCar] = useState("any");
  const [source, setSource] = useState<SourceTab["key"]>("all");
  const [author, setAuthor] = useState("");
  const [sortAsc, setSortAsc] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const importInputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const authorQuery = author.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (track !== "any" && r.trackOrdinal !== Number(track)) return false;
      if (car !== "any" && r.carOrdinal !== Number(car)) return false;
      if (source !== "all" && r.source !== source) return false;
      if (authorQuery && !r.author.toLowerCase().includes(authorQuery)) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const ta = a.lapTimeSec ?? Number.POSITIVE_INFINITY;
      const tb = b.lapTimeSec ?? Number.POSITIVE_INFINITY;
      if (ta === tb) return 0;
      return sortAsc ? ta - tb : tb - ta;
    });
    return filtered;
  }, [rows, track, car, source, author, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const resetView = () => {
    setPage(0);
    setOpenKey(null);
  };
  const pickTrack = (v: string) => {
    setTrack(v);
    resetView();
  };
  const pickCar = (v: string) => {
    setCar(v);
    resetView();
  };
  const pickSource = (v: SourceTab["key"]) => {
    setSource(v);
    resetView();
  };

  return (
    <div className="max-w-5xl mx-auto p-4 pb-20 text-app-text">
      <div className="flex items-end justify-between gap-4 flex-wrap pb-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{props.title}</h1>
          {props.subtitle && <div className="text-[11px] text-app-text-muted tracking-wide mt-1.5">{props.subtitle}</div>}
        </div>
        <div className="flex items-center gap-2">
          {props.onImportFile && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) props.onImportFile?.(file);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="text-[11px] font-semibold uppercase tracking-wide border border-app-border text-app-text-secondary hover:text-app-text px-3.5 py-2 rounded disabled:opacity-50"
                onClick={() => importInputRef.current?.click()}
                disabled={props.importing}
              >
                {props.importing ? "Importing…" : "Import"}
              </button>
            </>
          )}
          <button type="button" className="text-[11px] font-bold uppercase tracking-wide bg-app-accent text-app-bg px-3.5 py-2 rounded" onClick={props.onNewTune}>
            + New tune
          </button>
        </div>
      </div>

      <div className="flex items-end gap-2.5 mb-3">
        <ComboBox label="1 · Track" variant="track" value={track} options={trackOptions} onChange={pickTrack} placeholder="Any track" />
        <span className="hidden sm:block text-app-text-dim pb-3">→</span>
        <ComboBox label="2 · Car" variant="car" value={car} options={carOptions} onChange={pickCar} placeholder="Any car" />
      </div>

      <div className="flex gap-1.5 items-center flex-wrap px-2.5 py-2 bg-app-surface border border-b-0 border-app-border rounded-t-lg">
        {sources.map((s) => (
          <button
            type="button"
            key={s.key}
            className={`text-[10px] uppercase tracking-wide px-2.5 py-1.5 rounded border ${source === s.key ? (TAB_ACTIVE[s.key] ?? TAB_ACTIVE.all) : "border-app-border text-app-text-muted hover:text-app-text-secondary"}`}
            onClick={() => pickSource(s.key)}
          >
            {s.label}
          </button>
        ))}
        <input
          type="text"
          value={author}
          placeholder="Search author…"
          onChange={(e) => {
            setAuthor(e.target.value);
            setPage(0);
            setOpenKey(null);
          }}
          className="text-[11px] bg-app-bg border border-app-border-input rounded px-2.5 py-1.5 text-app-text placeholder:text-app-text-dim outline-none focus:border-app-accent w-40"
        />
        <div className="flex-1" />
        {props.onRefresh && (
          <button
            type="button"
            className="text-[10px] uppercase tracking-wide text-app-text-muted hover:text-app-text-secondary disabled:opacity-50"
            onClick={props.onRefresh}
            disabled={props.refreshing}
          >
            {props.refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        )}
      </div>

      <div className="border border-app-border rounded-b-lg overflow-hidden">
        <div className={`${GRID} px-3 py-2.5 bg-app-bg text-[9px] uppercase tracking-wider text-app-text-dim`}>
          <span>#</span>
          <span>Tune</span>
          <span className="hidden sm:block">Author</span>
          <span className="hidden sm:block justify-self-end">Category</span>
          <button type="button" className="justify-self-end uppercase tracking-wider text-app-accent inline-flex items-center gap-1" onClick={() => setSortAsc((a) => !a)}>
            Lap time <span className="text-[8px]">{sortAsc ? "▲" : "▼"}</span>
          </button>
          <span className="hidden sm:block" />
        </div>
        {pageRows.map((row, i) => (
          <TuneBrowserRow
            key={row.key}
            row={row}
            rank={safePage * PAGE_SIZE + i + 1}
            isOpen={openKey === row.key}
            onToggle={() => setOpenKey(openKey === row.key ? null : row.key)}
            onClone={props.onClone}
            onEdit={props.onEdit}
            onDelete={props.onDelete}
          />
        ))}
        {visible.length === 0 && <div className="text-center py-12 text-app-text-dim text-sm">No tunes match this filter.</div>}
      </div>

      {visible.length > 0 && (
        <div className="flex items-center justify-center gap-3.5 mt-3.5">
          <button
            type="button"
            className="font-mono text-[11px] uppercase tracking-wide bg-app-surface border border-app-border rounded-md px-3.5 py-2 hover:border-app-accent hover:text-app-accent disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
          >
            ← Prev
          </button>
          <span className="font-mono text-[11px] text-app-text-muted tabular-nums">
            {safePage * PAGE_SIZE + 1}–{Math.min(visible.length, (safePage + 1) * PAGE_SIZE)} of {visible.length} · page {safePage + 1}/{totalPages}
          </span>
          <button
            type="button"
            className="font-mono text-[11px] uppercase tracking-wide bg-app-surface border border-app-border rounded-md px-3.5 py-2 hover:border-app-accent hover:text-app-accent disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}
          >
            Next →
          </button>
        </div>
      )}
      <p className="text-[10px] text-app-text-dim mt-2.5">↕ Sort by lap time · pick a track to compare (times only compare within one track).</p>
    </div>
  );
}
