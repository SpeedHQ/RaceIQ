import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChangeEvent } from "react";
import { getSvmCapabilities, getSvmFieldAccess } from "@raceiq/game-lmu-metadata/setups/capabilities";
import { parseSVM, writeSVM } from "@raceiq/game-lmu-metadata/setups/svm";
import type { SvmDocument, SvmEdit } from "@raceiq/game-lmu-metadata/setups/svm";
import { useLmuSetupFiles, useSaveLmuSetup, fetchLmuSetupContent } from "@/hooks/lmu-setup-queries";
import type { LmuSetupContent } from "@/hooks/lmu-setup-queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { AppInput } from "@/components/ui/AppInput";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { m } from "@/paraglide/messages";
import { LmuSetupPages } from "./LmuSetupPages";
import { LmuSetupCompare } from "./LmuSetupCompare";
import { LmuSetupAdvice } from "./LmuSetupAdvice";

type Source = { kind: "file"; path: string; sha256: string } | { kind: "upload" };
interface Loaded { id: string; document: SvmDocument; source: Source; fileName: string }
type Slot = "active" | "a" | "b";
const ROOT_FOLDER = "__settings_root__";
const SLOTS: readonly Slot[] = ["active", "a", "b"];
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
  const listing = useLmuSetupFiles();
  const queryClient = useQueryClient();
  const save = useSaveLmuSetup();
  const uploadRef = useRef<HTMLInputElement>(null);
  const requests = useRef<Record<Slot, number>>({ active: 0, a: 0, b: 0 });
  const [activeLoading, setActiveLoading] = useState(false);
  const [compareLoading, setCompareLoading] = useState(0);
  const [active, setActive] = useState<Loaded | null>(null);
  const [compareA, setCompareA] = useState<Loaded | null>(null);
  const [compareB, setCompareB] = useState<Loaded | null>(null);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Loaded>>(new Map());
  const [pending, setPending] = useState<ReadonlyMap<string, number>>(new Map());
  const [candidate, setCandidate] = useState<Loaded | null>(null);
  const [tab, setTab] = useState("edit");
  const [filterCar, setFilterCar] = useState("");
  const [filterClass, setFilterClass] = useState("");
  const [filterTrack, setFilterTrack] = useState("");
  const [filename, setFilename] = useState("");
  const [trackFolder, setTrackFolder] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [targetParameter, setTargetParameter] = useState<string | null>(null);
  const files = listing.data?.files ?? [];
  const tracks = listing.data?.tracks ?? [];
  const rootExists = Boolean(listing.data?.baseDir);
  const dirty = pending.size > 0;
  const selectionState = useRef({ active, dirty });
  selectionState.current = { active, dirty };
  const nameValid = validFilename(filename);
  const activeFilePath = active?.source.kind === "file" ? active.source.path : null;
  const sourceValid = active?.source.kind === "upload" || (activeFilePath !== null && files.some((file) => file.path === activeFilePath && !file.error));
  const destinationValid = active?.source.kind === "file" || trackFolder === "" || tracks.some((track) => track.folder === trackFolder);
  const gameSaveEnabled = Boolean(active && sourceValid && rootExists && destinationValid && nameValid && dirty && !save.isPending);
  const capabilities = active ? getSvmCapabilities(active.document) : null;
  const filteredFiles = files.filter((file) => (!filterCar || file.carName === filterCar) && (!filterClass || file.className === filterClass) && (!filterTrack || file.trackFolder === (filterTrack === ROOT_FOLDER ? "" : filterTrack)));
  const carOptions = [{ value: "", label: m.lmu_setup_ws_all() }, ...[...new Set(files.flatMap((file) => file.carName ? [file.carName] : []))].map((value) => ({ value, label: value }))];
  const classOptions = [{ value: "", label: m.lmu_setup_ws_all() }, ...[...new Set(files.flatMap((file) => file.className ? [file.className] : []))].map((value) => ({ value, label: value }))];
  const trackOptions = [{ value: "", label: m.lmu_setup_ws_all() }, ...[...new Set(files.map((file) => file.trackFolder))].map((value) => ({ value: value || ROOT_FOLDER, label: value || m.lmu_setup_ws_root_folder() }))];
  const comparisonOptions = [...files.map((file) => ({ value: file.path, label: `${file.fileName} — ${file.trackFolder || m.lmu_setup_ws_root_folder()}`, disabled: Boolean(file.error) })), ...[...loaded.values()].filter((setup) => setup.source.kind === "upload").map((setup) => ({ value: setup.id, label: setup.fileName }))];
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
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || save.isPending) return;
    const request = ++requests.current.active;
    setActiveLoading(false);
    setCandidate(null);
    if (!/\.svm$/i.test(file.name) || file.size > 1024 * 1024) { setError(m.lmu_setup_ws_upload_invalid()); return; }
    try {
      const parsed = parseSVM(new Uint8Array(await file.arrayBuffer()));
      if (requests.current.active !== request) return;
      if (!parsed.ok) { setError(m.lmu_setup_ws_invalid_svm({ message: parsed.error, line: parsed.line === null ? "—" : String(parsed.line) })); return; }
      const next: Loaded = { id: `upload:${request}`, document: parsed.document, source: { kind: "upload" }, fileName: file.name };
      setLoaded((previous) => new Map(previous).set(next.id, next));
      requestActivation(next);
    } catch (reason) {
      if (requests.current.active === request) setError(reason instanceof Error ? reason.message : m.lmu_setup_ws_upload_invalid());
    }
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
      const source = active.source.kind === "file" ? active.source : { kind: "upload" as const, contentBase64: encodeBase64(active.document.originalBytes), trackFolder };
      const saved = await save.mutateAsync({ source, fileName: filename, edits: [...pending].map(([id, delta]) => ({ id, delta })) });
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
    setTrackFolder("");
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
    setLoaded((previous) => new Map([...previous].filter(([, setup]) => setup.source.kind === "upload")));
    setActiveLoading(false);
    try {
      await queryClient.cancelQueries({ queryKey: ["lmu-setup-content"] });
      await queryClient.invalidateQueries({ queryKey: ["lmu-setup-content"], refetchType: "none" });
      await listing.refetch();
      await Promise.all(SLOTS.map(async (slot) => {
        const current = selections[slot];
        if (current?.source.kind !== "file" || requests.current[slot] !== versions[slot]) return;
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
    <main className="flex min-w-0 flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-app-title">{m.lmu_setup_ws_title()}</h1><p>{m.lmu_setup_ws_description()}</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="app-outline" onClick={() => void refresh()} disabled={save.isPending}>{m.lmu_setup_ws_refresh()}</Button>
          <Button variant="app-primary" onClick={() => uploadRef.current?.click()} disabled={save.isPending}>{m.lmu_setup_ws_upload()}</Button>
          <input ref={uploadRef} className="hidden" aria-label={m.lmu_setup_ws_upload()} type="file" accept=".svm" onChange={(event) => void upload(event)} />
        </div>
      </header>
      {listing.isLoading && <p role="status">{m.common_loading()}</p>}
      {(!rootExists || files.length === 0) && !listing.isLoading && <p role="status">{rootExists ? m.lmu_setup_ws_empty_root() : m.lmu_setup_ws_missing_root()} {m.lmu_setup_ws_upload_hint()}</p>}
      {listing.isError && <p role="alert">{m.lmu_setup_ws_error({ message: listing.error.message })}</p>}
      {listing.data?.error && rootExists && <p role="alert">{m.lmu_setup_ws_error({ message: listing.data.error })}</p>}
      <section className="flex flex-wrap gap-3" aria-label={m.lmu_setup_ws_filters()}>
        <SearchSelect value={filterCar} onChange={setFilterCar} options={carOptions} ariaLabel={m.lmu_setup_ws_filter_car()} placeholder={m.lmu_setup_ws_filter_car()} />
        <SearchSelect value={filterClass} onChange={setFilterClass} options={classOptions} ariaLabel={m.lmu_setup_ws_filter_class()} placeholder={m.lmu_setup_ws_filter_class()} />
        <SearchSelect value={filterTrack} onChange={setFilterTrack} options={trackOptions} ariaLabel={m.lmu_setup_ws_filter_track()} placeholder={m.lmu_setup_ws_filter_track()} />
      </section>
      {files.length > 0 && <Table>
        <TableHeader><TableRow><TableHead>{m.lmu_setup_ws_active_setup()}</TableHead><TableHead>{m.lmu_setup_ws_filter_car()}</TableHead><TableHead>{m.lmu_setup_ws_filter_class()}</TableHead><TableHead>{m.lmu_setup_ws_filter_track()}</TableHead></TableRow></TableHeader>
        <TableBody>{filteredFiles.map((file) => <TableRow key={file.path}>
          <TableCell><Button variant="link" onClick={() => choose(file.path, "active")} disabled={Boolean(file.error) || save.isPending}>{file.fileName}</Button>{file.error && <p role="alert">{m.lmu_setup_ws_error({ message: file.error })}</p>}</TableCell>
          <TableCell>{file.carName ?? "—"}</TableCell><TableCell>{file.className ?? "—"}</TableCell><TableCell>{file.trackName || m.lmu_setup_ws_root_folder()}</TableCell>
        </TableRow>)}</TableBody>
      </Table>}
      {(activeLoading || compareLoading > 0) && <p role="status">{m.common_loading()}</p>}
      {active && <>
        <section className="flex flex-wrap items-center gap-2" aria-label={m.lmu_setup_ws_active_setup()}>
          <strong>{active.fileName}</strong><Badge>{active.document.carName}</Badge>
          <Badge variant="neutral">{active.document.className ?? m.lmu_setup_ws_unknown()}</Badge>
          <Badge variant="info">{capabilities?.architecture ?? m.lmu_setup_ws_unknown()}</Badge>
          {active.document.identityWarning && <p role="alert">{m.lmu_setup_ws_error({ message: active.document.identityWarning })}</p>}
        </section>
        <p role="status">{m.lmu_setup_ws_warning()}</p>
        {preview.length > 0 && <section aria-label={m.lmu_setup_ws_preview()}>
          <h2>{m.lmu_setup_ws_preview()}</h2>
          <Table><TableHeader><TableRow><TableHead>{m.lmu_setup_ws_field()}</TableHead><TableHead>{m.lmu_setup_ws_original()}</TableHead><TableHead>{m.lmu_setup_ws_proposed()}</TableHead><TableHead>{m.lmu_setup_ws_clicks()}</TableHead></TableRow></TableHeader>
            <TableBody>{preview.map((item) => <TableRow key={item.id}><TableCell>{item.id}</TableCell><TableCell>{item.before}</TableCell><TableCell>{item.after}</TableCell><TableCell>{item.delta > 0 ? "+" : ""}{item.delta}</TableCell></TableRow>)}</TableBody></Table>
        </section>}
        <div className="flex flex-wrap gap-2"><Button variant="app-outline" onClick={() => { setPending(new Map()); setError(null); }} disabled={!dirty || save.isPending}>{m.lmu_setup_ws_reset()}</Button><Button variant="app-primary" onClick={openSaveDialog} disabled={!dirty || save.isPending}>{m.lmu_setup_ws_save_download()}</Button></div>
      </>}
      {error && !dialogOpen && <p role="alert">{m.lmu_setup_ws_error({ message: error })}</p>}
      {savedPath && <p role="status">{m.lmu_setup_ws_saved_path({ path: savedPath })}</p>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList><TabsTrigger value="edit">{m.lmu_setup_ws_view_edit()}</TabsTrigger><TabsTrigger value="compare">{m.lmu_setup_ws_compare()}</TabsTrigger><TabsTrigger value="advice">{m.lmu_setup_ws_advice()}</TabsTrigger></TabsList>
        <TabsContent value="edit">{active ? <LmuSetupPages key={active.id + (active.source.kind === "file" ? active.source.sha256 : "")} document={active.document} pending={pending} onStep={changeDelta} /> : <p>{m.lmu_setup_ws_choose_or_upload()}</p>}</TabsContent>
        <TabsContent value="compare">
          <div className="flex flex-wrap gap-3 py-3">
            <SearchSelect value={compareA?.id ?? ""} onChange={(id) => choose(id, "a")} options={comparisonOptions} ariaLabel={m.lmu_setup_ws_compare_a()} placeholder={m.lmu_setup_ws_compare_a()} disabled={save.isPending} />
            <SearchSelect value={compareB?.id ?? ""} onChange={(id) => choose(id, "b")} options={comparisonOptions} ariaLabel={m.lmu_setup_ws_compare_b()} placeholder={m.lmu_setup_ws_compare_b()} disabled={save.isPending} />
          </div>
          <p>{m.lmu_setup_ws_compare_originals()}</p>
          <LmuSetupCompare a={compareA?.document ?? null} b={compareB?.document ?? null} onExplain={(id) => { setTargetParameter(id); setTab("advice"); }} />
        </TabsContent>
        <TabsContent value="advice"><LmuSetupAdvice document={active?.document ?? null} parameterId={targetParameter} onParameterChange={setTargetParameter} /></TabsContent>
      </Tabs>
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
          {active?.source.kind === "upload" && <SearchSelect value={trackFolder || ROOT_FOLDER} onChange={(value) => setTrackFolder(value === ROOT_FOLDER ? "" : value)} options={[{ value: ROOT_FOLDER, label: m.lmu_setup_ws_root_folder() }, ...tracks.map((track) => ({ value: track.folder, label: track.trackName }))]} ariaLabel={m.lmu_setup_ws_track_folder()} disabled={!rootExists || save.isPending} />}
          {!rootExists && <p>{m.lmu_setup_ws_save_requires_root()}</p>}
          <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={save.isPending} />{m.lmu_setup_ws_acknowledge()}</label>
          {error && <p role="alert">{m.lmu_setup_ws_error({ message: error })}</p>}
          <DialogFooter><Button variant="app-outline" onClick={download} disabled={!acknowledged || !nameValid || !dirty || save.isPending}>{m.lmu_setup_ws_download()}</Button><Button variant="app-primary" onClick={() => void saveGame()} disabled={!acknowledged || !gameSaveEnabled}>{save.isPending ? m.lmu_setup_ws_saving() : m.lmu_setup_ws_save_game()}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
