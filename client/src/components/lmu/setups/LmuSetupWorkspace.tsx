import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getSvmCapabilities, getSvmFieldAccess } from "@raceiq/game-lmu-metadata/setups/capabilities";
import { parseSVM, writeSVM } from "@raceiq/game-lmu-metadata/setups/svm";
import type { SvmEdit } from "@raceiq/game-lmu-metadata/setups/svm";
import { useLmuSetupFiles, useSaveLmuSetup, fetchLmuSetupContent } from "@/hooks/lmu-setup-queries";
import type { LmuSetupContent } from "@/hooks/lmu-setup-queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SessionImportModal } from "@/components/sessions/SessionImportModal";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { AppInput } from "@/components/ui/AppInput";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { m } from "@/paraglide/messages";
import { LmuSetupPages } from "./LmuSetupPages";
import { LmuSetupCompare } from "./LmuSetupCompare";
import { useLmuSetupSession, type LoadedLmuSetup as Loaded } from "@/stores/lmu-setups";
type Slot = "active" | "a" | "b";
const ROOT_FOLDER = "__settings_root__";
const SLOTS: readonly Slot[] = ["active", "a", "b"];
const PAGE_SIZE = 10;
function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function contentLoaded(content: LmuSetupContent): Loaded {
  const parsed = parseSVM(decodeBase64(content.contentBase64));
  if (!parsed.ok) throw new Error(parsed.error);
  return { id: content.path, document: parsed.document, source: { kind: "file", path: content.path, sha256: content.sha256 }, fileName: content.fileName };
}
function validFilename(name: string): boolean {
  if (!name || name !== name.trim() || /[<>:"/\\|?*]/.test(name) || [...name].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127) || /[. ]$/.test(name) || name === "." || name === "..") return false;
  const hasExtension = /\.[^.]+$/.test(name);
  const final = hasExtension ? name : `${name}.svm`;
  return final.length <= 160 && /\.svm$/i.test(final) && !/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(final);
}

export function LmuSetupWorkspace() {
  const navigate = useNavigate();
  const listing = useLmuSetupFiles();
  const queryClient = useQueryClient();
  const save = useSaveLmuSetup();
  const [importOpen, setImportOpen] = useState(false);
  const [importTrackFolder, setImportTrackFolder] = useState<string | null>(null);
  const [importFilename, setImportFilename] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);
  const requests = useRef<Record<Slot, number>>({ active: 0, a: 0, b: 0 });
  const [activeLoading, setActiveLoading] = useState(false);
  const [compareLoading, setCompareLoading] = useState(0);
  const { active, setActive, compareA, setCompareA, compareB, setCompareB, loaded, setLoaded, pending, setPending } = useLmuSetupSession();
  const [candidate, setCandidate] = useState<Loaded | null>(null);
  const [filterCar, setFilterCar] = useState("");
  const [filterClass, setFilterClass] = useState("");
  const [filterTrack, setFilterTrack] = useState("");
  const [page, setPage] = useState(0);
  const [filename, setFilename] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const files = listing.data?.files ?? [];
  const tracks = listing.data?.tracks ?? [];
  const rootExists = Boolean(listing.data?.baseDir);
  const dirty = pending.size > 0;
  const selectionState = useRef({ active, dirty });
  selectionState.current = { active, dirty };
  const nameValid = validFilename(filename);
  const sourceValid = Boolean(active && files.some((file) => file.path === active.source.path && !file.error));
  const gameSaveEnabled = Boolean(active && sourceValid && rootExists && nameValid && dirty && !save.isPending);
  const capabilities = active ? getSvmCapabilities(active.document) : null;
  const filteredFiles = files.filter((file) => (!filterCar || file.carName === filterCar) && (!filterClass || file.className === filterClass) && (!filterTrack || file.trackFolder === (filterTrack === ROOT_FOLDER ? "" : filterTrack)));
  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageFiles = filteredFiles.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const carOptions = [{ value: "", label: m.lmu_setup_ws_all() }, ...[...new Set(files.flatMap((file) => file.carName ? [file.carName] : []))].map((value) => ({ value, label: value }))];
  const classOptions = [{ value: "", label: m.lmu_setup_ws_all() }, ...[...new Set(files.flatMap((file) => file.className ? [file.className] : []))].map((value) => ({ value, label: value }))];
  const trackOptions = [{ value: "", label: m.lmu_setup_ws_all() }, ...[...new Set(files.map((file) => file.trackFolder))].map((value) => ({ value: value || ROOT_FOLDER, label: value || m.lmu_setup_ws_root_folder() }))];
  const selectableIds = files.filter((file) => !file.error).map((file) => file.path);
  const selectedIds = selectableIds.filter((id) => selected.has(id));
  const preview = active ? [...pending].map(([id, delta]) => ({ id, before: active.document.settings.get(id)!.index, after: active.document.settings.get(id)!.index + delta, delta })) : [];

  function activate(next: Loaded) {
    requests.current.active++;
    requests.current.a++;
    setActiveLoading(false);
    setActive(next);
    setPending(new Map());
    setCompareA(next);
    setError(null);
    setSavedPath(null);
  }
  function requestActivation(next: Loaded) {
    const current = selectionState.current;
    if (current.active?.document === next.document) return;
    if (current.active && current.dirty) setCandidate(next);
    else activate(next);
  }
  async function choose(id: string, slot: Slot) {
    if (!id || save.isPending) return;
    const request = ++requests.current[slot];
    if (slot === "active") setCandidate(null);
    const cached = loaded.get(id);
    if (cached) {
      if (slot === "active") {
        setActiveLoading(false);
        setCandidate(null);
        requestActivation(cached);
      } else if (slot === "a") setCompareA(cached);
      else setCompareB(cached);
      return;
    }
    if (slot === "active") setActiveLoading(true);
    else setCompareLoading((count) => count + 1);
    setError(null);
    try {
      const content = await queryClient.fetchQuery({
        queryKey: ["lmu-setup-content", id],
        queryFn: () => fetchLmuSetupContent(id),
        staleTime: 30_000,
      });
      if (requests.current[slot] !== request) return;
      const next = contentLoaded(content);
      setLoaded((previous) => new Map(previous).set(next.id, next));
      if (slot === "active") requestActivation(next);
      else if (slot === "a") setCompareA(next);
      else setCompareB(next);
    } catch (reason) {
      if (requests.current[slot] === request) setError(reason instanceof Error ? reason.message : m.lmu_setup_ws_upload_invalid());
    } finally {
      if (slot === "active" && requests.current[slot] === request) setActiveLoading(false);
      if (slot !== "active") setCompareLoading((count) => Math.max(0, count - 1));
    }
  }
  function changeDelta(ids: readonly string[], direction: 1 | -1) {
    if (!active || save.isPending) return;
    const changes: SvmEdit[] = [];
    for (const id of new Set(ids)) {
      const setting = active.document.settings.get(id);
      if (!setting || !getSvmFieldAccess(active.document, id).editable) { setError(m.lmu_setup_ws_locked()); return; }
      const delta = (pending.get(id) ?? 0) + direction;
      if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(setting.index + delta) || setting.index + delta < 0) { setError(m.lmu_setup_ws_invalid_click()); return; }
      changes.push({ id, delta });
    }
    const next = new Map(pending);
    for (const { id, delta } of changes) { if (delta === 0) next.delete(id); else next.set(id, delta); }
    setPending(next);
    setError(null);
  }
  async function upload(file: File) {
    if (save.isPending || !rootExists || importTrackFolder === null) return;
    if (!/\.svm$/i.test(file.name) || file.size > 1024 * 1024) throw new Error(m.lmu_setup_ws_upload_invalid());
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseSVM(bytes);
    if (!parsed.ok) throw new Error(m.lmu_setup_ws_invalid_svm({ message: parsed.error, line: parsed.line === null ? "—" : String(parsed.line) }));
    const saved = await save.mutateAsync({
      source: { kind: "upload", contentBase64: encodeBase64(bytes), trackFolder: importTrackFolder },
      fileName: importFilename || file.name,
      edits: [],
    });
    const next = contentLoaded(saved);
    requests.current.active++;
    setActiveLoading(false);
    setCandidate(null);
    setLoaded((previous) => new Map(previous).set(next.id, next));
    requestActivation(next);
    setSavedPath(saved.path);
  }
  function toggleSelection(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCompareOpen(false);
  }
  async function compareSelected() {
    if (selectedIds.length !== 2 || save.isPending) return;
    setCompareA(null);
    setCompareB(null);
    setCompareOpen(true);
    await Promise.all([choose(selectedIds[0]!, "a"), choose(selectedIds[1]!, "b")]);
  }
  function download() {
    if (!active || !acknowledged || !nameValid || !dirty || save.isPending) return;
    try {
      const edits = [...pending].map(([id, delta]) => ({ id, delta }));
      const bytes = writeSVM(active.document, edits);
      // Shared writer always returns a fresh, full ArrayBuffer-backed byte array.
      const blobBytes = bytes.buffer as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([blobBytes], { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = /\.svm$/i.test(filename) ? filename : `${filename}.svm`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setDialogOpen(false);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : m.lmu_setup_ws_download_failed()); }
  }
  async function saveGame() {
    if (!active || !acknowledged || !gameSaveEnabled) return;
    try {
      const saved = await save.mutateAsync({ source: active.source, fileName: filename, edits: [...pending].map(([id, delta]) => ({ id, delta })) });
      const next = contentLoaded(saved);
      setLoaded((previous) => new Map(previous).set(next.id, next));
      activate(next);
      setSavedPath(saved.path);
      setDialogOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : m.lmu_setup_ws_save_failed()); }
  }
  function openSaveDialog() {
    if (!active) return;
    setFilename(`${active.fileName.replace(/\.svm$/i, "")}-raceiq.svm`);
    setAcknowledged(false);
    setError(null);
    setDialogOpen(true);
  }

  async function refresh() {
    if (save.isPending) return;
    const selections = { active, a: compareA, b: compareB };
    const versions = {
      active: ++requests.current.active,
      a: ++requests.current.a,
      b: ++requests.current.b,
    };
    setCandidate(null);
    setLoaded(new Map());
    setActiveLoading(false);
    try {
      await queryClient.cancelQueries({ queryKey: ["lmu-setup-content"] });
      await queryClient.invalidateQueries({ queryKey: ["lmu-setup-content"], refetchType: "none" });
      await listing.refetch();
      await Promise.all(SLOTS.map(async (slot) => {
        const current = selections[slot];
        if (!current || requests.current[slot] !== versions[slot]) return;
        const path = current.source.path;
        try {
          const content = await queryClient.fetchQuery({
            queryKey: ["lmu-setup-content", path],
            queryFn: () => fetchLmuSetupContent(path),
            staleTime: 30_000,
          });
          if (requests.current[slot] !== versions[slot]) return;
          const next = contentLoaded(content);
          setLoaded((previous) => new Map(previous).set(next.id, next));
          if (slot === "active") {
            if (current.source.sha256 !== content.sha256) requestActivation(next);
          } else if (slot === "a") setCompareA(next);
          else setCompareB(next);
        } catch (reason) {
          if (requests.current[slot] === versions[slot]) setError(reason instanceof Error ? reason.message : m.lmu_setup_ws_upload_invalid());
        }
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : m.lmu_setup_ws_upload_invalid());
    }
  }

  return (
    <main className="min-w-0 p-4">
      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Button
          type="button"
          className="text-app-caption uppercase tracking-wide text-app-text-muted hover:text-app-text-secondary disabled:opacity-50 rounded"
          onClick={() => void refresh()}
          disabled={listing.isFetching || save.isPending}
        >
          {listing.isFetching ? m.setup_refreshing() : m.setup_refresh_button()}
        </Button>
        <Button type="button" variant="app-outline" size="app-md" onClick={() => { setImportTrackFolder(filterTrack ? (filterTrack === ROOT_FOLDER ? "" : filterTrack) : null); setImportFilename(""); setImportOpen(true); }} disabled={save.isPending}>
          {m.setup_import_button()}
        </Button>
        <Button type="button" variant="app-outline" onClick={() => void navigate({ to: "/lmu/setups/guides" })} disabled={save.isPending}>
          {m.lmu_guide_title()}
        </Button>
        {selectedIds.length === 2 && <Button type="button" variant="app-outline" size="app-md" onClick={() => void compareSelected()} disabled={save.isPending || compareLoading > 0}>
          {m.lmu_setup_ws_compare()}
        </Button>}
        <section className="ml-auto flex w-full flex-wrap items-center gap-2 @3xl/workspace:w-auto" aria-label={m.lmu_setup_ws_filters()}>
          <SearchSelect className="w-full @3xl/workspace:w-48" value={filterTrack} onChange={(value) => { setFilterTrack(value); setPage(0); }} options={trackOptions} ariaLabel={m.lmu_setup_ws_filter_track()} placeholder={m.setup_any_track()} />
          <SearchSelect className="w-full @3xl/workspace:w-48" value={filterCar} onChange={(value) => { setFilterCar(value); setPage(0); }} options={carOptions} ariaLabel={m.lmu_setup_ws_filter_car()} placeholder={m.setup_any_car()} />
          <SearchSelect className="w-full @3xl/workspace:w-48" value={filterClass} onChange={(value) => { setFilterClass(value); setPage(0); }} options={classOptions} ariaLabel={m.lmu_setup_ws_filter_class()} placeholder={m.lmu_setup_ws_filter_class()} />
        </section>
      </div>
      {listing.isLoading && <p role="status">{m.common_loading()}</p>}
      {(!rootExists || files.length === 0) && !listing.isLoading && <p role="status">{rootExists ? m.lmu_setup_ws_empty_root() : m.lmu_setup_ws_missing_root()} {m.lmu_setup_ws_upload_hint()}</p>}
      {listing.isError && <p role="alert">{m.lmu_setup_ws_error({ message: listing.error.message })}</p>}
      {listing.data?.error && rootExists && <p role="alert">{m.lmu_setup_ws_error({ message: listing.data.error })}</p>}
      <Table className="table-fixed">
        <TableHeader><TableRow>
          <TableHead className="w-11 text-center"><input type="checkbox" className="size-4 accent-app-accent" aria-label={m.tunes_select_all()} checked={pageFiles.some((file) => !file.error) && pageFiles.filter((file) => !file.error).every((file) => selected.has(file.path))} disabled={save.isPending || !pageFiles.some((file) => !file.error)} onChange={(event) => { const checked = event.target.checked; setSelected((previous) => { const next = new Set(previous); for (const file of pageFiles) if (!file.error) { if (checked) next.add(file.path); else next.delete(file.path); } return next; }); setCompareOpen(false); }} /></TableHead>
          <TableHead>{m.setup_table_rank()}</TableHead><TableHead>{m.setup_table_tune()}</TableHead>
          <TableHead className="hidden @3xl/workspace:table-cell">{m.label_car()}</TableHead>
          <TableHead className="hidden @3xl/workspace:table-cell">{m.label_track()}</TableHead>
          <TableHead className="hidden @3xl/workspace:table-cell">{m.label_category()}</TableHead>
        </TableRow></TableHeader>
        <TableBody>{pageFiles.map((file, index) => <TableRow key={file.path} className={`transition-colors hover:bg-app-surface-hover/50 ${active?.id === file.path ? "bg-app-surface-hover/50" : ""}`}>
          <TableCell className="text-center"><input type="checkbox" className="size-4 accent-app-accent" aria-label={file.fileName} checked={selected.has(file.path)} disabled={Boolean(file.error) || save.isPending} onChange={() => toggleSelection(file.path)} /></TableCell>
          <TableCell className="px-3 py-2 text-center font-mono text-app-text-muted tabular-nums"><span className="text-sm font-bold">{safePage * PAGE_SIZE + index + 1}</span></TableCell>
          <TableCell className="px-3 py-2 text-app-text">
            <button type="button" className="block w-full min-w-0 text-left disabled:opacity-50" aria-pressed={active?.id === file.path} onClick={() => void choose(file.path, "active")} disabled={Boolean(file.error) || save.isPending}>
              <span className="block truncate text-app-body font-semibold">{file.fileName}</span>
              <span className="mt-1 block truncate text-app-caption text-app-text-muted">{file.trackName || m.lmu_setup_ws_root_folder()}</span>
            </button>
            {file.error && <p role="alert" className="mt-1 text-app-caption text-app-text-muted">{m.lmu_setup_ws_error({ message: file.error })}</p>}
          </TableCell>
          <TableCell className="hidden @3xl/workspace:table-cell truncate px-3 py-2 text-app-text-secondary">{file.carName ?? "—"}</TableCell>
          <TableCell className="hidden @3xl/workspace:table-cell truncate px-3 py-2 text-app-text-secondary">{file.trackName || m.lmu_setup_ws_root_folder()}</TableCell>
          <TableCell className="hidden @3xl/workspace:table-cell px-3 py-2 text-app-text-secondary">{file.className && <Badge variant="neutral">{file.className}</Badge>}</TableCell>
        </TableRow>)}
          {filteredFiles.length === 0 && <TableRow><TableCell className="text-center" colSpan={6}><div className="py-10 text-app-text-muted">{m.setup_no_matches()}</div></TableCell></TableRow>}
        </TableBody>
      </Table>
      {filteredFiles.length > 0 && <div className="mt-3.5 flex items-center justify-center gap-3.5">
        <Button type="button" className="font-mono text-app-compact uppercase tracking-wide bg-app-surface border border-app-border rounded-md px-3.5 py-2 hover:border-app-accent hover:text-app-accent disabled:opacity-40 disabled:cursor-not-allowed" onClick={() => setPage(safePage - 1)} disabled={safePage === 0}>{m.setup_prev_button()}</Button>
        <span className="font-mono text-app-compact text-app-text-muted tabular-nums">{safePage * PAGE_SIZE + 1}–{Math.min(filteredFiles.length, (safePage + 1) * PAGE_SIZE)} of {filteredFiles.length} · page {safePage + 1}/{totalPages}</span>
        <Button type="button" className="font-mono text-app-compact uppercase tracking-wide bg-app-surface border border-app-border rounded-md px-3.5 py-2 hover:border-app-accent hover:text-app-accent disabled:opacity-40 disabled:cursor-not-allowed" onClick={() => setPage(safePage + 1)} disabled={safePage >= totalPages - 1}>{m.setup_next_button()}</Button>
      </div>}
      {(activeLoading || compareLoading > 0) && <p role="status">{m.common_loading()}</p>}
      {active && <>
        <section className="mt-4 flex flex-wrap items-center gap-2 border-t border-app-border pt-4" aria-label={m.lmu_setup_ws_active_setup()}>
          <strong>{active.fileName}</strong><Badge>{active.document.carName}</Badge>
          <Badge variant="neutral">{active.document.className ?? m.lmu_setup_ws_unknown()}</Badge>
          <Badge variant="info">{capabilities?.architecture ?? m.lmu_setup_ws_unknown()}</Badge>
          {active.document.identityWarning && <p role="alert">{m.lmu_setup_ws_error({ message: active.document.identityWarning })}</p>}
        </section>
        <p className="my-3 text-app-caption text-app-text-muted" role="status">{m.lmu_setup_ws_warning()}</p>
        {preview.length > 0 && <section aria-label={m.lmu_setup_ws_preview()}>
          <h2>{m.lmu_setup_ws_preview()}</h2>
          <Table><TableHeader><TableRow><TableHead>{m.lmu_setup_ws_field()}</TableHead><TableHead>{m.lmu_setup_ws_original()}</TableHead><TableHead>{m.lmu_setup_ws_proposed()}</TableHead><TableHead>{m.lmu_setup_ws_clicks()}</TableHead></TableRow></TableHeader>
            <TableBody>{preview.map((item) => <TableRow key={item.id}><TableCell>{item.id}</TableCell><TableCell>{item.before}</TableCell><TableCell>{item.after}</TableCell><TableCell>{item.delta > 0 ? "+" : ""}{item.delta}</TableCell></TableRow>)}</TableBody></Table>
        </section>}
        <div className="flex flex-wrap gap-2"><Button variant="app-outline" onClick={() => { setPending(new Map()); setError(null); }} disabled={!dirty || save.isPending}>{m.lmu_setup_ws_reset()}</Button><Button variant="app-primary" onClick={openSaveDialog} disabled={!dirty || save.isPending}>{m.lmu_setup_ws_save_download()}</Button></div>
      </>}
      {error && !dialogOpen && <p role="alert">{m.lmu_setup_ws_error({ message: error })}</p>}
      {savedPath && <p role="status">{m.lmu_setup_ws_saved_path({ path: savedPath })}</p>}
      {active && <div className="mt-4"><LmuSetupPages key={active.id + active.source.sha256} document={active.document} pending={pending} onStep={changeDelta} /></div>}
      <Dialog open={compareOpen && selectedIds.length === 2} onOpenChange={setCompareOpen}>
        <DialogContent size="lg" layout="scrollable">
          <DialogHeader><DialogTitle>{m.lmu_setup_ws_compare()}</DialogTitle><DialogDescription>{m.lmu_setup_ws_compare_originals()}</DialogDescription></DialogHeader>
          <div className="flex flex-wrap gap-3"><strong>{compareA?.fileName}</strong><strong>{compareB?.fileName}</strong></div>
          {compareLoading > 0 ? <p role="status">{m.common_loading()}</p> : <LmuSetupCompare a={compareA?.document ?? null} b={compareB?.document ?? null} onExplain={(parameter) => { setCompareOpen(false); void navigate({ to: "/lmu/setups/guides", search: { parameter } }); }} />}
          {error && <p role="alert">{m.lmu_setup_ws_error({ message: error })}</p>}
        </DialogContent>
      </Dialog>
      {importOpen && <SessionImportModal gameId="lmu" onClose={() => setImportOpen(false)} setupImport={{
        accept: ".svm",
        hint: m.lmu_setup_ws_upload_hint(),
        onInspect: async (file) => {
          setImportTrackFolder(null);
          setImportFilename(file.name);
          if (!/\.svm$/i.test(file.name) || file.size > 1024 * 1024) throw new Error(m.lmu_setup_ws_upload_invalid());
          const parsed = parseSVM(new Uint8Array(await file.arrayBuffer()));
          if (!parsed.ok) throw new Error(m.lmu_setup_ws_invalid_svm({ message: parsed.error, line: parsed.line === null ? "—" : String(parsed.line) }));
          return <div className="text-app-text space-y-1">
            <p className="font-semibold">{parsed.document.carName}</p>
            <p className="text-app-text-muted">Le Mans Ultimate · {parsed.document.className}</p>
          </div>;
        },
        onImport: upload,
        disabled: !rootExists || importTrackFolder === null || (importFilename !== "" && !validFilename(importFilename)) || save.isPending,
        fields: <>
          <SearchSelect value={importTrackFolder === null ? "" : importTrackFolder || ROOT_FOLDER} onChange={(value) => setImportTrackFolder(value === ROOT_FOLDER ? "" : value || null)} options={[{ value: ROOT_FOLDER, label: m.lmu_setup_ws_root_folder() }, ...tracks.map((track) => ({ value: track.folder, label: track.trackName }))]} ariaLabel={m.lmu_setup_ws_track_folder()} placeholder={m.lmu_setup_ws_track_folder()} disabled={!rootExists || save.isPending} />
          <div className="space-y-1">
            <label className="block" htmlFor="lmu-import-filename">{m.lmu_setup_ws_filename()}</label>
            <AppInput id="lmu-import-filename" value={importFilename} onChange={(event) => setImportFilename(event.target.value)} placeholder={m.lmu_setup_ws_import_filename_hint()} disabled={save.isPending} />
            {importFilename !== "" && !validFilename(importFilename) && <p role="alert">{m.lmu_setup_ws_invalid_filename()}</p>}
          </div>
          {!rootExists && <p role="alert">{m.lmu_setup_ws_missing_root()}</p>}
        </>,
      }} />}
      <Dialog open={candidate !== null} onOpenChange={(open) => { if (!open) setCandidate(null); }}>
        <DialogContent><DialogHeader><DialogTitle>{m.lmu_setup_ws_discard_title()}</DialogTitle><DialogDescription>{m.lmu_setup_ws_discard_description()}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="app-outline" onClick={() => setCandidate(null)}>{m.lmu_setup_ws_keep_edits()}</Button><Button variant="app-primary" onClick={() => { if (candidate) activate(candidate); setCandidate(null); }}>{m.lmu_setup_ws_discard_switch()}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!save.isPending) setDialogOpen(open); }}>
        <DialogContent><DialogHeader><DialogTitle>{m.lmu_setup_ws_save_title()}</DialogTitle><DialogDescription>{m.lmu_setup_ws_warning()}</DialogDescription></DialogHeader>
          <label htmlFor="lmu-new-filename">{m.lmu_setup_ws_filename()}</label>
          <AppInput id="lmu-new-filename" value={filename} onChange={(event) => setFilename(event.target.value)} aria-invalid={!nameValid} disabled={save.isPending} />
          {!nameValid && <p role="alert">{m.lmu_setup_ws_invalid_filename()}</p>}
          {!rootExists && <p>{m.lmu_setup_ws_save_requires_root()}</p>}
          <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={save.isPending} />{m.lmu_setup_ws_acknowledge()}</label>
          {error && <p role="alert">{m.lmu_setup_ws_error({ message: error })}</p>}
          <DialogFooter><Button variant="app-outline" onClick={download} disabled={!acknowledged || !nameValid || !dirty || save.isPending}>{m.lmu_setup_ws_download()}</Button><Button variant="app-primary" onClick={() => void saveGame()} disabled={!acknowledged || !gameSaveEnabled}>{save.isPending ? m.lmu_setup_ws_saving() : m.lmu_setup_ws_save_game()}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
