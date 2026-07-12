import { useMemo, useState } from "react";
import { ComboBox, type ComboOption } from "./ComboBox";
import { TuneBrowserRow } from "./TuneBrowserRow";
import "./tune-browser.css";
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
  onRefresh?: () => void;
  refreshing?: boolean;
}

const SOURCE_MOD: Record<string, string> = { community: "com", user: "you" };
const PAGE_SIZE = 10;

export function TuneBrowser(props: TuneBrowserProps) {
  const { rows, trackOptions, carOptions, sources } = props;
  const [track, setTrack] = useState("any");
  const [car, setCar] = useState("any");
  const [source, setSource] = useState<SourceTab["key"]>("all");
  const [sortAsc, setSortAsc] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);

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

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  // Reset paging + open row whenever a filter narrows the list.
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
    <div className="tt">
      <div className="tt-title">
        <div>
          <h1>{props.title}</h1>
          {props.subtitle && <div className="tt-car">{props.subtitle}</div>}
        </div>
        <button type="button" className="tt-add" onClick={props.onNewTune}>
          + NEW TUNE
        </button>
      </div>

      <div className="tt-searchrow">
        <ComboBox label="1 · Track" variant="track" value={track} options={trackOptions} onChange={pickTrack} placeholder="Any track" />
        <span className="tt-arrow">→</span>
        <ComboBox label="2 · Car" variant="car" value={car} options={carOptions} onChange={pickCar} placeholder="Any car" />
      </div>

      <div className="tt-ctrl">
        {sources.map((s) => (
          <button type="button" key={s.key} className={`tt-f ${source === s.key ? `on ${SOURCE_MOD[s.key] ?? ""}` : ""}`} onClick={() => pickSource(s.key)}>
            {s.label}
          </button>
        ))}
        <div className="tt-grow" />
        {props.onRefresh && (
          <button type="button" className="tt-refresh" onClick={props.onRefresh} disabled={props.refreshing}>
            {props.refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        )}
      </div>

      <div className="tt-tower">
        <div className="tt-thead">
          <span>#</span>
          <span>Tune</span>
          <span className="tt-col-hide">Author</span>
          <span className="r tt-col-hide">Category</span>
          <button type="button" className="tt-thsort" onClick={() => setSortAsc((a) => !a)}>
            Lap time <span className="car">{sortAsc ? "▲" : "▼"}</span>
          </button>
          <span />
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
        {visible.length === 0 && <div className="tt-empty">No tunes match this filter.</div>}
      </div>

      {visible.length > 0 && (
        <div className="tt-pager">
          <button type="button" className="tt-pgbtn" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}>
            ← Prev
          </button>
          <span className="tt-pginfo">
            {safePage * PAGE_SIZE + 1}–{Math.min(visible.length, (safePage + 1) * PAGE_SIZE)} of {visible.length} · page {safePage + 1}/{totalPages}
          </span>
          <button type="button" className="tt-pgbtn" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}>
            Next →
          </button>
        </div>
      )}
      <p className="tt-note">↕ Sort by lap time · pick a track to compare (times only compare within one track).</p>
    </div>
  );
}
