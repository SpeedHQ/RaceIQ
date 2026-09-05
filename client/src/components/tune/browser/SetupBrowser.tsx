import { type ReactNode, useMemo, useRef, useState } from "react";
import { AppInput } from "@/components/ui/AppInput";
import { SortableTH, Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { m } from "@/paraglide/messages";
import { TuneBrowserRow } from "./TuneBrowserRow";
import type { SourceTab, TuneRow } from "./types";

export interface SetupBrowserProps {
  rows: TuneRow[];
  carNames: Record<number, string>;
  trackNames: Record<number, string>;
  trackOptions: Array<{ value: string; label: string }>;
  carOptions: Array<{ value: string; label: string }>;
  sources: SourceTab[];
  renderSettings: (row: TuneRow, unit: "metric" | "imperial") => ReactNode;
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
  community: "border-(--tune-source-community) text-(--tune-source-community)",
  user: "border-(--tune-source-user) text-(--tune-source-user)",
};

export function SetupBrowser(props: SetupBrowserProps) {
  const { rows, trackOptions, carOptions, sources } = props;
  const [track, setTrack] = useState("");
  const [car, setCar] = useState("");
  const [source, setSource] = useState<SourceTab["key"]>("all");
  const [author, setAuthor] = useState("");
  const [sortAsc, setSortAsc] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const importInputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const authorQuery = author.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (track && r.trackOrdinal !== Number(track)) return false;
      if (car && r.carOrdinal !== Number(car)) return false;
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
    setTrack(v === "any" ? "" : v);
    resetView();
  };
  const pickCar = (v: string) => {
    setCar(v === "any" ? "" : v);
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
    <div className="w-full min-w-0 p-3 pb-20 text-app-text @3xl/workspace:p-4">
      <div className="flex flex-wrap items-center gap-2 pb-4">
        {sources.map((s) => (
          <Button
            type="button"
            key={s.key}
            className={`text-app-caption uppercase tracking-wide px-2.5 py-1.5 rounded border ${source === s.key ? (TAB_ACTIVE[s.key] ?? TAB_ACTIVE.all) : "border-app-border text-app-text-muted hover:text-app-text-secondary"}`}
            onClick={() => pickSource(s.key)}
          >
            {s.label}
          </Button>
        ))}
        <AppInput
          type="text"
          value={author}
          placeholder={m.setup_search_author()}
          onChange={(e) => pickAuthor(e.target.value)}
          className="text-app-compact w-40"
        />
        {props.onRefresh && (
          <Button
            type="button"
            className="text-app-caption uppercase tracking-wide text-app-text-muted hover:text-app-text-secondary disabled:opacity-50 rounded"
            onClick={props.onRefresh}
            disabled={props.refreshing}
          >
            {props.refreshing ? m.setup_refreshing() : m.setup_refresh_button()}
          </Button>
        )}
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
            <Button
              type="button"
              className="text-app-compact font-semibold uppercase tracking-wide border border-app-border text-app-text-secondary hover:text-app-text px-3.5 py-2 rounded disabled:opacity-50"
              onClick={() => importInputRef.current?.click()}
              disabled={props.importing}
            >
              {props.importing ? m.setup_importing() : m.setup_import_button()}
            </Button>
          </>
        )}
        {props.onNewTune && (
          <Button type="button" variant="app-primary" size="app-md" onClick={props.onNewTune}>
            {m.setup_new_tune()}
          </Button>
        )}
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 @3xl/workspace:w-auto">
          <SearchSelect className="w-full @3xl/workspace:w-48" value={track} options={trackOptions} onChange={pickTrack} placeholder={m.setup_any_track()} />
          <SearchSelect className="w-full @3xl/workspace:w-48" value={car} options={carOptions} onChange={pickCar} placeholder={m.setup_any_car()} />
        </div>
      </div>

      <Table fit layout="fixed">
        <THead>
          <TH>{m.setup_table_rank()}</TH>
          <TH>{m.setup_table_tune()}</TH>
          <TH showFrom="workspace-md">{m.label_car()}</TH>
          <TH showFrom="workspace-md">{m.label_track()}</TH>
          <TH showFrom="workspace-md">{m.label_category()}</TH>
          <TH showFrom="workspace-md">{m.label_author()}</TH>
          <SortableTH align="end" direction={sortAsc ? "ascending" : "descending"} onSort={() => setSortAsc((ascending) => !ascending)}>
            {m.label_lap()}
          </SortableTH>
          <TH showFrom="workspace-md" visuallyHidden>
            {m.label_actions()}
          </TH>
        </THead>
        <TBody>
          {pageRows.map((row, index) => (
            <TuneBrowserRow
              key={row.key}
              row={row}
              rank={safePage * PAGE_SIZE + index + 1}
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
          {visible.length === 0 && (
            <TRow variant="separator">
              <TD align="center" colSpan={8} tone="primary">
                <div className="py-10">{m.setup_no_matches()}</div>
              </TD>
            </TRow>
          )}
        </TBody>
      </Table>

      {visible.length > 0 && (
        <div className="flex items-center justify-center gap-3.5 mt-3.5">
          <Button
            type="button"
            className="font-mono text-app-compact uppercase tracking-wide bg-app-surface border border-app-border rounded-md px-3.5 py-2 hover:border-app-accent hover:text-app-accent disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
          >
            {m.setup_prev_button()}
          </Button>
          <span className="font-mono text-app-compact text-app-text-muted tabular-nums">
            {safePage * PAGE_SIZE + 1}–{Math.min(visible.length, (safePage + 1) * PAGE_SIZE)} of {visible.length} · page {safePage + 1}/{totalPages}
          </span>
          <Button
            type="button"
            className="font-mono text-app-compact uppercase tracking-wide bg-app-surface border border-app-border rounded-md px-3.5 py-2 hover:border-app-accent hover:text-app-accent disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}
          >
            {m.setup_next_button()}
          </Button>
        </div>
      )}
      <p className="text-app-caption text-app-text-dim mt-2.5">{m.setup_sort_info()}</p>
    </div>
  );
}
