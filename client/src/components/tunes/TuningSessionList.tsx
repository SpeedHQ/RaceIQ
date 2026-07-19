import { type DragEvent, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SearchSelect } from "../ui/SearchSelect";
import { SetupFilePicker } from "./SetupFilePicker";
import {
  type TuningSession,
  useCreateTuningSession,
  usePlaceSetup,
  useSetupFiles,
  useTuningSessions,
} from "../../hooks/queries";

/**
 * TuningSessionList — the Setup Engineer landing page (plan §6a). Lists the
 * driver's tuning sessions and creates new ones. A tuning session is the parent
 * container for the whole Setup IQ loop (base setup → stints → versions); the
 * dashboard/detail/autotune views open *inside* a selected session.
 *
 * `onOpen(id)` navigates to the session workspace route
 * (`/<game>/tune/$tuningSessionId`).
 */
export function TuningSessionList({
  gameId,
  onOpen,
}: {
  gameId: "acc" | "ac-evo";
  onOpen: (id: number) => void;
}) {
  const { data: sessions = [], isLoading } = useTuningSessions(gameId);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div className="space-y-2">
        <div>
          <h1 className="text-lg font-semibold text-app-text">Tuning sessions</h1>
          <p className="text-xs text-app-text-dim mt-0.5">
            A tuning session tracks one car + track as you iterate setups — base setup, stints driven, and (soon) versions with lap deltas.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="self-start px-3 py-1.5 text-xs rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold"
        >
          + New session
        </button>
      </div>

      {creating && (
        <NewTuningSessionModal
          gameId={gameId}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); onOpen(id); }}
        />
      )}

      <TuningSessionTable sessions={sessions} onOpen={onOpen} isLoading={isLoading} />
    </div>
  );
}

function TuningSessionTable({
  sessions,
  onOpen,
  isLoading,
}: {
  sessions: TuningSession[];
  onOpen: (id: number) => void;
  isLoading: boolean;
}) {
  return (
    <div className="overflow-x-auto border border-app-border rounded-lg">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-app-text-muted border-b border-app-border">
            <th className="px-3 py-2 font-medium w-12 text-right">#</th>
            <th className="px-3 py-2 font-medium">Session</th>
            <th className="px-3 py-2 font-medium">Car</th>
            <th className="px-3 py-2 font-medium">Track</th>
            <th className="px-3 py-2 font-medium">Base setup</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Last active</th>
            <th className="px-3 py-2 font-medium sr-only">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-xs text-app-text-dim">
                {isLoading ? "Loading sessions…" : "No tuning sessions yet. Create one above to get started."}
              </td>
            </tr>
          )}
          {sessions.map((s) => {
            const base = s.baseSetupPath?.split(/[\\/]/).pop() ?? "—";
            return (
              <tr
                key={s.id}
                onClick={() => onOpen(s.id)}
                className="border-b border-app-border/60 last:border-0 hover:bg-app-panel/60 cursor-pointer"
              >
                <td className="px-3 py-2 text-right font-mono text-app-text-dim tabular-nums">{s.seq}</td>
                <td className="px-3 py-2 font-medium text-app-text">{s.name}</td>
                <td className="px-3 py-2 text-app-text-dim">{s.carName ?? "—"}</td>
                <td className="px-3 py-2 text-app-text-dim">{s.trackName ?? "—"}</td>
                <td className="px-3 py-2 text-app-text-dim font-mono text-xs max-w-[220px] truncate" title={s.baseSetupPath ?? undefined}>{base}</td>
                <td className="px-3 py-2 text-app-text-dim whitespace-nowrap">{new Date(s.updatedAt).toLocaleDateString()}</td>
                <td className="px-3 py-2 text-right">
                  <span className="text-purple-400 text-xs font-semibold">Resume →</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * New-session modal: drag in a saved setup file (or pick car → track → setup
 * from the cascading dropdowns), name the session, create. ACC/AC-Evo only
 * expose setups the driver saved in-game, so the base setup determines car +
 * track — a session is always one car + one track.
 */
function NewTuningSessionModal({
  gameId,
  onClose,
  onCreated,
}: {
  gameId: "acc" | "ac-evo";
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { data: setupFiles, isLoading: loadingFiles } = useSetupFiles(gameId);
  const create = useCreateTuningSession();
  const place = usePlaceSetup();
  // Cascading pick — car → track → setup file — so a driver with hundreds of
  // setups narrows down instead of scrolling one giant flat list.
  const [car, setCar] = useState("");
  const [track, setTrack] = useState("");
  const [baseSetupPath, setBaseSetupPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A dropped setup that isn't in the Setups folder yet — offer to place it there
  // (car from the file's content; track the driver picks) instead of rejecting it.
  const [pendingDrop, setPendingDrop] = useState<{ fileName: string; content: unknown; carName: string } | null>(null);
  const [placeCar, setPlaceCar] = useState("");
  const [placeTrack, setPlaceTrack] = useState("");

  const files = setupFiles?.files ?? [];
  const noFiles = !loadingFiles && files.length === 0;

  // Place-into-Setups track options: the full canonical ACC track roster (so the
  // driver can place a setup for any track, not only ones they already have a
  // folder for) unioned with whatever folders they do have (catches AC-Evo and
  // any key not in the canonical list).
  const allTracks = useMemo(() => {
    // Canonical roster from tracks.csv (server, setupFolder column) unioned with
    // whatever track folders the driver already has (catches any key not in csv).
    const canonical = setupFiles?.tracks ?? [];
    return [...new Set([...canonical, ...files.map((f) => f.trackName)])].sort();
  }, [setupFiles, files]);

  // Default the name from the chosen car+track so the driver can just click Create.
  const effectiveName = name.trim() || (car && track ? `${car} @ ${track}` : "");
  const canCreate = !!car && !!track && !!baseSetupPath && !!effectiveName;

  // Drag-in: match the dropped .json against the Setups listing so the stored
  // baseSetupPath is always a real, guarded file under the Setups folder (the
  // browser can't hand us the dropped file's absolute path). Fall back to the
  // file's own `carName` to at least pre-select the car.
  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    await processFile(e.dataTransfer.files?.[0]);
  };

  const processFile = async (file: File | undefined | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setDropNote("Pick a .json setup file.");
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setDropNote("Couldn't read that file as JSON.");
      return;
    }
    const carName = typeof parsed?.carName === "string" ? parsed.carName : undefined;

    const byName = files.filter((f) => f.fileName === file.name);
    const match = byName.length === 1 ? byName[0] : carName ? byName.find((f) => f.carModel === carName) : undefined;
    if (match) {
      setCar(match.carModel);
      setTrack(match.trackName);
      setBaseSetupPath(match.absolutePath);
      setPendingDrop(null);
      setDropNote(null);
      return;
    }
    // Not in the Setups folder — offer to place it there rather than rejecting.
    setPendingDrop({ fileName: file.name, content: parsed, carName: carName ?? "" });
    setPlaceCar(carName ?? "");
    setPlaceTrack("");
    setDropNote(null);
  };

  const doPlace = async () => {
    if (!pendingDrop || !placeCar.trim() || !placeTrack.trim()) return;
    setError(null);
    try {
      const r = await place.mutateAsync({
        gameId,
        carName: placeCar.trim(),
        trackName: placeTrack.trim(),
        fileName: pendingDrop.fileName,
        content: pendingDrop.content,
      });
      setCar(r.carModel);
      setTrack(r.trackName);
      setBaseSetupPath(r.absolutePath);
      setPendingDrop(null);
      setDropNote(r.placed ? `Placed ${r.fileName} in your Setups folder — ready to use.` : `A setup named ${r.fileName} already existed there — using it.`);
    } catch (err: any) {
      setError(err?.message ?? "Couldn't place the setup");
    }
  };

  const submit = async () => {
    if (!canCreate) return;
    setError(null);
    try {
      const s = await create.mutateAsync({ gameId, name: effectiveName, carName: car, trackName: track, baseSetupPath });
      onCreated(s.id);
    } catch (err: any) {
      setError(err?.message ?? "Could not create tuning session");
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[680px] max-w-[94vw] flex flex-col gap-4 p-5"
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-app-text">New tuning session</p>
          <button type="button" onClick={onClose} className="text-app-text-dim hover:text-app-text text-xl leading-none">×</button>
        </div>

        {/* Drag-in / click-to-browse zone */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => { void processFile(e.target.files?.[0]); e.target.value = ""; }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`w-full rounded-lg border border-dashed px-3 py-8 text-center text-xs transition-colors ${
            dragging ? "border-purple-500 bg-purple-500/10 text-app-text" : "border-app-border text-app-text-dim hover:border-purple-500/60"
          }`}
        >
          Drag a saved setup <span className="font-mono">.json</span> here, or click to browse
          <br />— pins car + track. Or pick them below.
        </button>
        {dropNote && <div className="text-[11px] text-amber-400">{dropNote}</div>}

        {/* Place a dropped setup that isn't in the Setups folder yet. Car comes
            from the file's carName; the driver names the track (ACC setup JSON
            has no track). Writes it under Setups/<car>/<track>/ so it's usable. */}
        {pendingDrop && (
          <div className="rounded-lg border border-purple-500/40 bg-purple-500/5 p-3 space-y-2">
            <div className="text-[11px] text-app-text">
              <span className="font-mono">{pendingDrop.fileName}</span> isn't in your Setups folder yet — add it and pick its track:
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-app-text-muted uppercase tracking-wider">Car folder</span>
                <input
                  value={placeCar}
                  onChange={(e) => setPlaceCar(e.target.value)}
                  placeholder="car key"
                  className="bg-app-bg border border-app-border rounded px-2 py-1 text-xs font-mono w-[180px]"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-app-text-muted uppercase tracking-wider">Track</span>
                <div className="w-[180px]">
                  <SearchSelect
                    value={placeTrack}
                    onChange={setPlaceTrack}
                    options={allTracks.map((t) => ({ value: t, label: t }))}
                    placeholder={allTracks.length ? "Search tracks…" : "No track folders yet"}
                    disabled={allTracks.length === 0}
                    focusColor="purple-500"
                  />
                </div>
              </label>
              <button
                type="button"
                onClick={doPlace}
                disabled={place.isPending || !placeCar.trim() || !placeTrack.trim()}
                className="px-3 py-1.5 text-xs rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-semibold"
              >
                {place.isPending ? "Placing…" : "Add to Setups & use"}
              </button>
              <button type="button" onClick={() => setPendingDrop(null)} className="px-2 py-1.5 text-xs text-app-text-dim hover:text-app-text">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Cascading searchable pickers */}
        <SetupFilePicker
          gameId={gameId}
          value={{ car, track, setupPath: baseSetupPath }}
          onChange={(v) => { setCar(v.car); setTrack(v.track); setBaseSetupPath(v.setupPath); }}
        />

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-app-text-muted uppercase tracking-wider">Session name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={car && track ? `${car} @ ${track}` : "Session name"}
            maxLength={120}
            className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs"
          />
        </label>

        {car && track && baseSetupPath && (
          <div className="text-[11px] text-app-text-dim">
            Pinned to <span className="text-app-text font-medium">{car}</span> · <span className="text-app-text font-medium">{track}</span> — each session is one car + track.
          </div>
        )}
        {noFiles && (
          <div className="text-[11px] text-amber-400">
            No saved setups found. In-game, open <span className="font-mono">Setup → Save</span> (even the default) so it appears here.
          </div>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-app-border text-app-text-dim hover:text-app-text">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={create.isPending || !canCreate}
            title={!canCreate ? "Pick car, track, and a base setup" : undefined}
            className="px-3 py-1.5 text-xs rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-semibold"
          >
            {create.isPending ? "Creating…" : "Create session"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
