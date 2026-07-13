import { type ReactNode, useMemo, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import { ComboBox, type ComboOption } from "./ComboBox";
import { TUNE_GRID, TuneBrowserRow } from "./TuneBrowserRow";
import type { SourceTab, TuneRow } from "./types";

export interface SetupBrowserProps {
  rows: TuneRow[];
  carNames: Record<number, string>;
  trackNames: Record<number, string>;
  trackOptions: ComboOption[];
  carOptions: ComboOption[];
  sources: SourceTab[];
  renderSettings: (row: TuneRow) => ReactNode;
  onClone?: (row: TuneRow) => void;
  onEdit?: (row: TuneRow) => void;
  onDelete?: (row: TuneRow) => void;
  onDuplicate?: (row: TuneRow) => void;
  isDuplicating?: boolean;
  onNewTune?: () => void;
  /** Read-only browse mode: hides create/import and per-row owner actions
   *  (used for game sources that surface community setups you can't edit). */
  readOnly?: boolean;
  onImportFile?: (file: File) => void;
  importing?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Extra header action rendered next to "+ New tune" — e.g. a link to a
   *  dedicated import-from-file page instead of the built-in file picker. */
  headerExtra?: ReactNode;
}

const PAGE_SIZE = 10;

// Active-tab colouring per source.
const TAB_ACTIVE: Record<string, string> = {
  all: "border-app-accent text-app-accent",
  community: "border-pink-400 text-pink-400",
  user: "border-emerald-400 text-emerald-400",
};

export function SetupBrowser(props: SetupBrowserProps) {
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
  const pickAuthor = (v: string) => {
    setAuthor(v);
    resetView();
  };

  return (
    <div className="w-full p-4 pb-20 text-app-text">
      <div className="flex items-center gap-2 flex-wrap pb-4">
        {props.headerExtra}
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
              {props.importing ? m.setup_importing() : m.setup_import_button()}
            </button>
          </>
        )}
        {props.onNewTune && (
          <button type="button" className="text-[11px] font-bold uppercase tracking-wide bg-app-accent text-app-bg px-3.5 py-2 rounded" onClick={props.onNewTune}>
            {m.setup_new_tune()}
          </button>
        )}
      </div>

      <div className="flex items-end gap-2.5 mb-3">
        <ComboBox label={m.setup_track_label()} variant="track" value={track} options={trackOptions} onChange={pickTrack} placeholder={m.setup_any_track()} />
        <span className="hidden sm:block text-app-text-dim pb-3">{m.setup_arrow()}</span>
        <ComboBox label={m.setup_car_label()} variant="car" value={car} options={carOptions} onChange={pickCar} placeholder={m.setup_any_car()} />
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
          placeholder={m.setup_search_author()}
          onChange={(e) => pickAuthor(e.target.value)}
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
            {props.refreshing ? m.setup_refreshing() : m.setup_refresh_button()}
          </button>
        )}
      </div>

      <div className="border border-app-border rounded-b-lg overflow-hidden">
        <div className={`${TUNE_GRID} px-3 py-2.5 bg-app-bg text-[9px] uppercase tracking-wider text-app-text-dim`}>
          <span>{m.setup_table_rank()}</span>
          <span>{m.setup_table_tune()}</span>
          <span className="hidden sm:block">{m.setup_table_car()}</span>
          <span className="hidden sm:block">{m.setup_table_track()}</span>
          <span className="hidden sm:block">{m.setup_table_category()}</span>
          <span className="hidden sm:block">{m.setup_table_author()}</span>
          <button type="button" className="justify-self-end uppercase tracking-wider text-app-accent inline-flex items-center gap-1" onClick={() => setSortAsc((a) => !a)}>
            {m.setup_table_laptime()} <span className="text-[8px]">{sortAsc ? "▲" : "▼"}</span>
          </button>
          <span className="hidden sm:block" />
        </div>
        {pageRows.map((row, i) => (
          <TuneBrowserRow
            key={row.key}
            row={row}
            rank={safePage * PAGE_SIZE + i + 1}
            carName={props.carNames[row.carOrdinal] ?? `Car #${row.carOrdinal}`}
            trackName={row.trackOrdinal != null ? (props.trackNames[row.trackOrdinal] ?? `Track #${row.trackOrdinal}`) : null}
            isOpen={openKey === row.key}
            onToggle={() => setOpenKey(openKey === row.key ? null : row.key)}
            onClone={props.onClone}
            onEdit={props.onEdit}
            onDelete={props.onDelete}
            onDuplicate={props.onDuplicate}
            isDuplicating={props.isDuplicating}
            renderSettings={props.renderSettings}
            readOnly={props.readOnly}
          />
        ))}
        {visible.length === 0 && <div className="text-center py-12 text-app-text-dim text-sm">{m.setup_no_matches()}</div>}
      </div>

      {visible.length > 0 && (
        <div className="flex items-center justify-center gap-3.5 mt-3.5">
          <button
            type="button"
            className="font-mono text-[11px] uppercase tracking-wide bg-app-surface border border-app-border rounded-md px-3.5 py-2 hover:border-app-accent hover:text-app-accent disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
          >
            {m.setup_prev_button()}
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
            {m.setup_next_button()}
          </button>
        </div>
      )}
      <p className="text-[10px] text-app-text-dim mt-2.5">{m.setup_sort_info()}</p>
    </div>
  );
}
