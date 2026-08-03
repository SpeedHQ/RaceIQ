import { DEFAULT_EXPERIMENT_FOCUS, EXPERIMENT_FOCUS_LABELS, type ExperimentFocus } from "@shared/experiments/focus";
import { AccSetupJsonSchema, setupFileFormat, setupFileRejectReason } from "@shared/setups/file-formats";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type Experiment,
  type ExperimentGameId,
  useAccCarName,
  useCreateExperiment,
  useExperiments,
  useInspectCarSetup,
  usePlaceSetup,
  useResolveNames,
  useSetupFiles,
  useTracks,
} from "../../hooks/queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { Table, TBody, TD, TH, THead, TRow } from "../ui/AppTable";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { SearchSelect } from "../ui/SearchSelect";
import { FocusPicker } from "./FocusPicker";
import { SetupFilePicker } from "./SetupFilePicker";

/**
 * ExperimentList — the Setup Engineer landing page (plan §6a). Lists the
 * driver's experiments and creates new ones. An experiment is the parent
 * container for the whole Setup IQ loop (base setup → stints → versions); the
 * dashboard/detail/autotune views open *inside* a selected session.
 *
 * `onOpen(id)` navigates to the session workspace route
 * (`/<game>/experiments/$experimentId`).
 */
export function ExperimentList({ gameId, onOpen }: { gameId: ExperimentGameId; onOpen: (id: number) => void }) {
  const { data: sessions = [], isLoading } = useExperiments(gameId);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-3 @3xl/workspace:p-4">
      <div className="space-y-2">
        <div>
          <h1 className="text-app-title font-semibold text-app-text">Experiments</h1>
          <p className="mt-0.5 text-app-subtext text-app-text-dim">An experiment tracks one car + track as you iterate setups — base setup, stints driven, and (soon) versions with lap deltas.</p>
        </div>
        <Button variant="app-primary" size="app-md" onClick={() => setCreating(true)} className="self-start">
          + New experiment
        </Button>
      </div>

      {creating &&
        (gameId === "f1-2025" ? (
          <NewF1ExperimentModal
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              onOpen(id);
            }}
          />
        ) : (
          <NewExperimentModal
            gameId={gameId}
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              onOpen(id);
            }}
          />
        ))}

      <ExperimentTable sessions={sessions} onOpen={onOpen} isLoading={isLoading} gameId={gameId} />
    </div>
  );
}

/** What an experiment is working on right now. Purple = the car is being
 * varied, sky = the driver is. */
export function FocusBadge({ focus }: { focus: ExperimentFocus }) {
  return (
    <Badge
      variant="neutral"
      size="default"
      className={`whitespace-nowrap ${focus === "driver" ? "border-(--focus-driver)/30 bg-(--focus-driver)/15 text-(--focus-driver)" : "border-(--focus-setup)/30 bg-(--focus-setup)/15 text-(--focus-setup)"}`}
    >
      {EXPERIMENT_FOCUS_LABELS[focus]}
    </Badge>
  );
}

function ExperimentTable({ sessions, onOpen, isLoading, gameId }: { sessions: Experiment[]; onOpen: (id: number) => void; isLoading: boolean; gameId: ExperimentGameId }) {
  const accCarName = useAccCarName();
  const carName = (n: string | null | undefined) => (gameId === "acc" ? accCarName(n) : n) ?? "—";

  return (
    <Card className="min-w-0 max-w-full overflow-x-auto">
      <Table fit layout="fixed">
        <THead>
          <TH align="end" showFrom="workspace-sm">
            #
          </TH>
          <TH>Session</TH>
          <TH showFrom="workspace-md">Varying</TH>
          <TH showFrom="workspace-md">Car</TH>
          <TH showFrom="workspace-lg">Track</TH>
          <TH showFrom="workspace-lg">Base setup</TH>
          <TH showFrom="workspace-xl">Last active</TH>
          <TH visuallyHidden>Actions</TH>
        </THead>
        <TBody>
          {sessions.length === 0 && (
            <TRow variant="separator">
              <TD align="center" colSpan={8} tone="dim">
                <div className="py-4">{isLoading ? "Loading experiments…" : "No experiments yet. Create one above to get started."}</div>
              </TD>
            </TRow>
          )}
          {sessions.map((s) => {
            const base = s.baseSetupPath?.split(/[\\/]/).pop() ?? "—";
            return (
              <TRow key={s.id} onClick={() => onOpen(s.id)}>
                <TD align="end" showFrom="workspace-sm" numeric tone="dim">
                  {s.seq}
                </TD>
                <TD emphasis tone="primary" truncate="wide">
                  {s.name}
                </TD>
                <TD showFrom="workspace-md">
                  <FocusBadge focus={s.focus} />
                </TD>
                <TD showFrom="workspace-md" tone="dim">
                  {carName(s.carName)}
                </TD>
                <TD showFrom="workspace-lg" tone="dim">
                  {s.trackName ?? "—"}
                </TD>
                <TD showFrom="workspace-lg" numeric tone="dim" truncate="wide" title={s.baseSetupPath ?? undefined}>
                  {base}
                </TD>
                <TD showFrom="workspace-xl" nowrap tone="dim">
                  {new Date(s.updatedAt).toLocaleDateString()}
                </TD>
                <TD align="end">
                  <span className="text-xs font-semibold text-app-accent">Resume →</span>
                </TD>
              </TRow>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}

/**
 * New-session modal: drag in a saved setup file (or pick car → track → setup
 * from the cascading dropdowns), name the session, create. ACC/AC-Evo only
 * expose setups the driver saved in-game, so the base setup determines car +
 * track — a session is always one car + one track.
 */
function NewExperimentModal({ gameId, onClose, onCreated }: { gameId: "acc" | "ac-evo"; onClose: () => void; onCreated: (id: number) => void }) {
  const { data: setupFiles, isLoading: loadingFiles } = useSetupFiles(gameId);
  const create = useCreateExperiment();
  const place = usePlaceSetup();
  const inspect = useInspectCarSetup();
  // Cascading pick — car → track → setup file — so a driver with hundreds of
  // setups narrows down instead of scrolling one giant flat list.
  const [car, setCar] = useState("");
  const [track, setTrack] = useState("");
  const [baseSetupPath, setBaseSetupPath] = useState("");
  const [name, setName] = useState("");
  // What the experiment opens on. Switchable afterwards from the workspace —
  // this is only the starting mode, so it never needs to be a hard choice.
  const [focus, setFocus] = useState<ExperimentFocus>(DEFAULT_EXPERIMENT_FOCUS);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Only things the driver has to act on or know about — a refused file, a
  // .carsetup with no car id. Success is NOT a notice: it's the pinned card's
  // status pill, so "Placed X" and "X is already in your Setups folder" can't
  // both be on screen contradicting each other.
  const [notice, setNotice] = useState<{ tone: "warn" | "error"; text: string } | null>(null);
  /** How the pinned file got there — drives the card's status pill. */
  const [dropStatus, setDropStatus] = useState<"matched" | "placed" | "existing" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The dropped file's payload, kept whether or not it matched something
  // already in the Setups folder — a match must not throw the bytes away, or
  // the same setup could never be imported for a second track.
  const [pendingDrop, setPendingDrop] = useState<{ fileName: string; content?: unknown; contentBase64?: string; carName: string } | null>(null);
  // Whether the "add it to Setups" form is open. Separate from `pendingDrop`
  // so a matched file can still be placed under a different track on request.
  const [placing, setPlacing] = useState(false);
  const [placeCar, setPlaceCar] = useState("");
  const [placeTrack, setPlaceTrack] = useState("");

  const files = setupFiles?.files ?? [];
  const noFiles = !loadingFiles && files.length === 0;

  // Place-into-Setups track options: the full canonical ACC track roster (so the
  // driver can place a setup for any track, not only ones they already have a
  // folder for) unioned with whatever folders they do have (catches AC-Evo and
  // any key not in the canonical list).
  // The value stays the on-disk folder key (that's what gets written), but the
  // label is the circuit's real name — "Brands Hatch GP", not "brands_hatch".
  // The server already resolves these from tracks.csv and ships them as
  // `trackNames`, including the layout variant so GP and Indy stay distinct.
  // A folder with no canonical name falls back to its key, which is the most
  // honest label available for it.
  const allTracks = useMemo(() => {
    // Canonical roster from tracks.csv (server, setupFolder column) unioned with
    // whatever track folders the driver already has (catches any key not in csv).
    const canonical = setupFiles?.tracks ?? [];
    const names = setupFiles?.trackNames ?? {};
    return [...new Set([...canonical, ...files.map((f) => f.trackName)])].map((key) => ({ value: key, label: names[key] ?? key })).sort((a, b) => a.label.localeCompare(b.label));
  }, [setupFiles, files]);

  // Car options for the place-into-Setups picker: the canonical roster (friendly
  // name, slug value) unioned with any car folder the driver already has — the
  // roster is a static CSV that lags game updates, so their disk is the more
  // current source for anything new.
  // A car read out of a dropped file that predates our static roster (and that
  // the driver has no folder for yet) is added as a real option rather than
  // handled as a display-only fallback — it must stay selectable, not just
  // visible.
  const allPlaceCars = useMemo(() => {
    const roster = setupFiles?.cars ?? [];
    const byModel = new Map(roster.map((c) => [c.model, c.name] as const));
    for (const f of files) if (!byModel.has(f.carModel)) byModel.set(f.carModel, f.carModel);
    if (placeCar && !byModel.has(placeCar)) byModel.set(placeCar, placeCar);
    // Label is the car's real name; the slug is the value, not something to
    // read. A car with no canonical name falls back to its folder key.
    return [...byModel.entries()].map(([model, name]) => ({ value: model, label: name })).sort((a, b) => a.label.localeCompare(b.label));
  }, [setupFiles, files, placeCar]);

  // Default the name from the chosen car+track so the driver can just click Create.
  const effectiveName = name.trim() || (car && track ? `${car} @ ${track}` : "");
  // A driving experiment varies the driver, not the car, so it does not need a
  // base setup file to start — the driver may simply want to work on braking in
  // whatever they are running. A setup experiment still does: its arms ARE setup
  // files, and there is nothing to version without one.
  const canCreate = !!car && !!track && !!effectiveName && (focus === "driver" || !!baseSetupPath);

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
    // Each game takes exactly one format (ACC → .json, AC EVO → .carsetup), so
    // the wrong game's file is refused here rather than sent to a route that
    // would reject it anyway — and the message names the mismatch.
    const reject = setupFileRejectReason(gameId, file.name);
    if (reject) {
      setNotice({ tone: "warn", text: reject });
      return;
    }
    setNotice(null);
    const isCarSetup = setupFileFormat(gameId).payload === "binary";

    // AC EVO `.carsetup` is protobuf, not JSON — it travels as base64. Its
    // preset id names the car, but reading it needs a decode only the server
    // can do, so the bytes go there first.
    let parsed: any;
    let base64: string | undefined;
    let carName: string | undefined;
    // Set when a .carsetup tells us something the driver needs to know about
    // its car id; survives the match/place branches below.
    let carSetupNote: string | null = null;
    if (isCarSetup) {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      // Chunked: String.fromCharCode(...buf) blows the argument limit on a
      // file of any real size.
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      base64 = btoa(bin);
      try {
        const info = await inspect.mutateAsync(base64);
        // The file states its own car folder, so this is prefilled even for a
        // car missing from our static roster (`knownCar` false) — the folder
        // name is still correct, only the friendly display name is unknown.
        carName = info.carModel ?? undefined;
        // Not every .carsetup carries a car. The preset id (wire field #9) is
        // what names it, and a file saved without one decodes perfectly while
        // identifying nothing — so say that plainly rather than silently
        // leaving the field blank and looking broken.
        carSetupNote =
          info.carModel == null
            ? "This .carsetup doesn't contain a car id — pick the car folder yourself."
            : info.knownCar
              ? null
              : `Car read from the file as "${info.carModel}" — not in our car list, so double-check the folder.`;
      } catch (err: any) {
        setNotice({ tone: "error", text: err?.message ?? "Couldn't read that .carsetup file." });
        return;
      }
    } else {
      let raw: unknown;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        setNotice({ tone: "error", text: "Couldn't read that file as JSON." });
        return;
      }
      // Shape gate — a .json that isn't a setup (a lap export, a tune catalog
      // entry) must not end up written into the Setups folder. Loose on
      // purpose: only the keys every Kunos setup has.
      const check = AccSetupJsonSchema.safeParse(raw);
      if (!check.success) {
        setNotice({ tone: "error", text: "That .json doesn't look like a saved setup — it needs a carName and basicSetup." });
        return;
      }
      parsed = check.data;
      carName = parsed.carName;
    }

    const payload = isCarSetup ? { fileName: file.name, contentBase64: base64, carName: carName ?? "" } : { fileName: file.name, content: parsed, carName: carName ?? "" };

    const byName = files.filter((f) => f.fileName === file.name);
    const match = byName.length === 1 ? byName[0] : carName ? byName.find((f) => f.carModel === carName) : undefined;
    // A file already in the Setups folder is pinned for convenience — but the
    // payload is retained and the form stays available, because "I already
    // imported this setup for Spa" is not a reason to refuse importing it for
    // Monza. Copying it per track is the normal way to run the same base setup
    // at more than one circuit.
    setPendingDrop(payload);
    setPlaceCar(match?.carModel || carName || "");
    setPlaceTrack("");
    if (match) {
      setCar(match.carModel);
      setTrack(match.trackName);
      setBaseSetupPath(match.absolutePath);
      setPlacing(false);
      setDropStatus("matched");
      // The folder the file was matched into already names the car, so an
      // absent car id inside the file is no longer worth flagging.
      setNotice(null);
      return;
    }
    // Not in the Setups folder at all — go straight to placing it.
    setPlacing(true);
    setDropStatus(null);
    setNotice(carSetupNote ? { tone: "warn", text: carSetupNote } : null);
  };

  /** Unpin the dropped file and everything it selected. */
  const clearDrop = () => {
    setPendingDrop(null);
    setDropStatus(null);
    setNotice(null);
    setPlacing(false);
    setCar("");
    setTrack("");
    setBaseSetupPath("");
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
        // Exactly one of these is set — the server rejects both or neither.
        ...(pendingDrop.contentBase64 != null ? { contentBase64: pendingDrop.contentBase64 } : { content: pendingDrop.content }),
      });
      setCar(r.carModel);
      setTrack(r.trackName);
      setBaseSetupPath(r.absolutePath);
      // Keep the payload: the driver may want this same setup at a third
      // track. Only the form closes.
      setPlacing(false);
      // The outcome is the card's status pill, not a separate line of prose —
      // `placed` means a copy was written under the new track, `false` means an
      // identically-named setup was already there and is reused as-is.
      setDropStatus(r.placed ? "placed" : "existing");
      setNotice(null);
    } catch (err: any) {
      setError(err?.message ?? "Couldn't place the setup");
    }
  };

  const submit = async () => {
    if (!canCreate) return;
    setError(null);
    try {
      const s = await create.mutateAsync({
        gameId,
        name: effectiveName,
        carName: car,
        trackName: track,
        // A driving experiment may legitimately have none.
        baseSetupPath: baseSetupPath || null,
        focus,
      });
      onCreated(s.id);
    } catch (err: any) {
      setError(err?.message ?? "Could not create experiment");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" layout="scrollable" className="flex w-[680px] max-w-[94vw] flex-col">
        <DialogHeader className="flex flex-row items-center justify-between">
          <DialogTitle className="text-sm font-semibold">New experiment</DialogTitle>
          <Button variant="app-ghost" size="icon-sm" onClick={onClose} className="text-xl leading-none text-app-text-dim hover:text-app-text" aria-label="Close">
            ×
          </Button>
        </DialogHeader>
        {/* What this experiment starts on. Presented as a starting mode rather
            than a type, because it is switchable from the workspace at any
            point — the driver who fixes a balance problem and then wants to
            work on braking stays in the same experiment. */}
        <FocusPicker value={focus} onChange={setFocus} />

        {/* Drag-in / click-to-browse zone */}
        <input
          ref={fileInputRef}
          type="file"
          accept={setupFileFormat(gameId).accept}
          className="hidden"
          onChange={(e) => {
            void processFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button
          variant="app-outline"
          size="app-md"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`w-full rounded-lg border border-dashed px-3 text-center text-xs transition-colors ${
            pendingDrop ? "py-4" : "py-8"
          } ${dragging ? "border-app-accent bg-app-accent/10 text-app-text" : "border-app-border text-app-text-dim hover:border-app-accent/60"}`}
        >
          {pendingDrop ? (
            <>
              Drop another <span className="font-mono">{setupFileFormat(gameId).extension}</span> to replace it
            </>
          ) : (
            <>
              Drag a saved <span className="font-mono">{setupFileFormat(gameId).extension}</span> setup here, or click to browse
              <br />— pins car + track. Or pick them below.
            </>
          )}
        </Button>
        {notice && (
          <div
            className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-app-compact ${
              notice.tone === "error" ? "border-status-danger/40 bg-status-danger/10 text-status-danger" : "border-status-warning/40 bg-status-warning/10 text-status-warning"
            }`}
          >
            <span aria-hidden className="leading-none">
              {notice.tone === "error" ? "✕" : "!"}
            </span>
            <span className="flex-1">{notice.text}</span>
          </div>
        )}

        {/* The pinned file, as one card instead of a stack of status sentences.
            The same base setup is routinely run at several circuits, and a
            filename match must not decide that for the driver — so "Copy to
            another track" stays offered here, and writes a real copy under
            Setups/<car>/<newTrack>/ rather than repointing at the existing one. */}
        {pendingDrop && !placing && (
          <div className="rounded-lg border border-app-border bg-app-bg/40 p-3">
            <div className="flex items-start gap-3">
              <span className="shrink-0 rounded bg-app-border/40 px-1.5 py-0.5 font-mono text-app-caption uppercase tracking-wider text-app-text-dim">
                {setupFileFormat(gameId).extension.slice(1)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-app-text truncate" title={pendingDrop.fileName}>
                    {pendingDrop.fileName}
                  </span>
                  {dropStatus && (
                    <Badge variant={dropStatus === "placed" ? "success" : "neutral"} size="compact">
                      {dropStatus === "placed" ? "Copied to Setups" : dropStatus === "existing" ? "Already saved there" : "Found in Setups"}
                    </Badge>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-app-compact text-app-text-dim">
                  <span>
                    Car <span className="text-app-text">{allPlaceCars.find((c) => c.value === car)?.label ?? car ?? "—"}</span>
                  </span>
                  <span>
                    Track <span className="text-app-text">{allTracks.find((t) => t.value === track)?.label ?? track ?? "—"}</span>
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="app-outline"
                  size="app-sm"
                  onClick={() => {
                    setPlacing(true);
                    setPlaceTrack("");
                    setNotice(null);
                  }}
                >
                  Copy to another track
                </Button>
                <Button variant="app-ghost" size="icon-xs" onClick={clearDrop} aria-label="Remove this setup" title="Remove this setup">
                  ×
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Place a dropped setup that isn't in the Setups folder yet. Car comes
            from the file's carName; the driver names the track (ACC setup JSON
            has no track). Writes it under Setups/<car>/<track>/ so it's usable. */}
        {pendingDrop && placing && (
          <div className="rounded-lg border border-app-accent/40 bg-app-accent/5 p-3 space-y-2">
            {/* Two ways in: a file that was never in Setups, and an existing
                one the driver chose to copy to a second circuit. Saying "isn't
                in your Setups folder yet" in the second case is simply false. */}
            <div className="text-app-compact text-app-text">
              <span className="font-mono">{pendingDrop.fileName}</span>{" "}
              {dropStatus == null ? "isn't in your Setups folder yet — add it and pick its track:" : "will be copied into the track folder you pick — the existing copy stays where it is:"}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-app-caption text-app-text-muted uppercase tracking-wider">Car folder</span>
                {/* A picker, not free text: when the file names its own car
                    this is already selected, but a .carsetup saved without a
                    preset id carries no car at all — and nobody should have to
                    type "ford_mustang_gt3" from memory. */}
                <div className="w-[180px]">
                  <SearchSelect
                    value={placeCar}
                    onChange={setPlaceCar}
                    options={allPlaceCars}
                    placeholder={allPlaceCars.length ? "Search cars…" : "No cars found"}
                    disabled={allPlaceCars.length === 0}
                    focusColor="purple-500"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-app-caption text-app-text-muted uppercase tracking-wider">Track</span>
                <div className="w-[180px]">
                  <SearchSelect
                    value={placeTrack}
                    onChange={setPlaceTrack}
                    options={allTracks}
                    placeholder={allTracks.length ? "Search tracks…" : "No track folders yet"}
                    disabled={allTracks.length === 0}
                    focusColor="purple-500"
                  />
                </div>
              </div>
              <Button variant="app-primary" size="app-md" onClick={doPlace} disabled={place.isPending || !placeCar.trim() || !placeTrack.trim()}>
                {place.isPending ? "Placing…" : "Add to Setups & use"}
              </Button>
              <Button variant="app-ghost" size="app-sm" onClick={() => setPlacing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* A driving experiment still needs car + track (an experiment is always
            one car at one circuit) but the setup file is optional there. */}
        {focus === "driver" && (
          <p className="-mb-2 text-app-compact text-app-text-dim">Pick the car and track you're driving. A base setup is optional for driving work — leave it blank to just log drills.</p>
        )}

        {/* Cascading searchable pickers */}
        <SetupFilePicker
          gameId={gameId}
          value={{ car, track, setupPath: baseSetupPath }}
          onChange={(v) => {
            setCar(v.car);
            setTrack(v.track);
            setBaseSetupPath(v.setupPath);
          }}
        />

        <label className="flex flex-col gap-1">
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Session name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={car && track ? `${car} @ ${track}` : "Session name"}
            maxLength={120}
            className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs"
          />
        </label>

        {/* Only when the pick came from the dropdowns — the dropped-file card
            above already states car + track, and saying it twice was half of
            what made this modal read as a pile of status lines. */}
        {car && track && baseSetupPath && !pendingDrop && (
          <div className="text-app-compact text-app-text-dim">
            Pinned to <span className="text-app-text font-medium">{car}</span> · <span className="text-app-text font-medium">{track}</span> — each session is one car + track.
          </div>
        )}
        {noFiles && (
          <div className="text-app-compact text-status-warning">
            No saved setups found. In-game, open <span className="font-mono">Setup → Save</span> (even the default) so it appears here.
          </div>
        )}
        {error && <div className="text-xs text-status-danger">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="app-outline" size="app-md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="app-primary" size="app-md" onClick={submit} disabled={create.isPending || !canCreate} title={!canCreate ? "Pick car, track, and a base setup" : undefined}>
            {create.isPending ? "Creating…" : "Create session"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * F1 2025's new-session modal (design Phase 10) — F1 exposes no saved setup
 * file to pick, so there's no SetupFilePicker/drag-in step here: the session
 * is created with a null base setup and the first base is captured from
 * telemetry instead (via useCaptureSetup, from the workspace's "+ Add base"
 * button). Car/track are optional free text, prefilled from the live packet's
 * ordinals when resolvable — otherwise left blank and backfilled from the
 * first lap.
 */
function NewF1ExperimentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const packet = useTelemetryStore((s) => s.packet);
  const { data: names } = useResolveNames(packet?.TrackOrdinal != null ? [packet.TrackOrdinal] : [], packet?.CarOrdinal != null ? [packet.CarOrdinal] : []);
  const liveCar = packet?.CarOrdinal != null ? (names?.carNames[String(packet.CarOrdinal)] ?? "") : "";
  const liveTrack = packet?.TrackOrdinal != null ? (names?.trackNames[String(packet.TrackOrdinal)] ?? "") : "";

  const { data: tracksData } = useTracks();

  const trackOptions = useMemo(() => {
    const list = (tracksData as { ordinal: number; name: string }[] | undefined) ?? [];
    return [...new Set(list.map((t) => t.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }));
  }, [tracksData]);

  const create = useCreateExperiment();
  const [name, setName] = useState("");
  const [car, setCar] = useState(liveCar);
  const [track, setTrack] = useState("");
  const [trackAutoSet, setTrackAutoSet] = useState(false);
  // Same choice every game offers — focus belongs to the experiment, not to a
  // game's setup format.
  const [focus, setFocus] = useState<ExperimentFocus>(DEFAULT_EXPERIMENT_FOCUS);
  const [error, setError] = useState<string | null>(null);

  // trackOptions may be empty on first render (query not resolved yet), so we
  // can't reliably prefill from the useState initializer — wait for the
  // options to load, then prefill once from the live packet's track, only if
  // the driver hasn't already picked one themselves.
  useEffect(() => {
    if (!trackAutoSet && !track && liveTrack && trackOptions.some((o) => o.value === liveTrack)) {
      setTrackAutoSet(true);
      setTrack(liveTrack);
    }
  }, [trackAutoSet, track, liveTrack, trackOptions]);

  const effectiveName = name.trim() || (track ? (car ? `${car} @ ${track}` : track) : "");
  const canCreate = !!effectiveName && !!track.trim();

  const submit = async () => {
    if (!canCreate) return;
    setError(null);
    try {
      const s = await create.mutateAsync({
        gameId: "f1-2025",
        name: effectiveName,
        carName: car.trim() || null,
        trackName: track.trim() || null,
        baseSetupPath: null,
        focus,
      });
      onCreated(s.id);
    } catch (err: any) {
      setError(err?.message ?? "Could not create experiment");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" layout="scrollable" className="flex w-[480px] max-w-[94vw] flex-col">
        <DialogHeader className="flex flex-row items-center justify-between">
          <DialogTitle className="text-sm font-semibold">New experiment</DialogTitle>
          <Button variant="app-ghost" size="icon-sm" onClick={onClose} className="text-xl leading-none text-app-text-dim hover:text-app-text" aria-label="Close">
            ×
          </Button>
        </DialogHeader>

        <FocusPicker value={focus} onChange={setFocus} />

        {focus === "car" && (
          <p className="text-app-compact text-app-text-dim">F1 setups are read from telemetry — your base setup will be captured from your first lap, or via "Capture current setup" in the session.</p>
        )}

        <div className="flex gap-2">
          <label className="flex flex-col gap-1 flex-1">
            <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Car (optional)</span>
            <input value={car} onChange={(e) => setCar(e.target.value)} placeholder="Car name" maxLength={200} className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs" />
          </label>
          <div className="flex flex-col gap-1 flex-1">
            <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Track</span>
            <SearchSelect value={track} onChange={setTrack} options={trackOptions} placeholder="Search tracks…" focusColor="purple-500" />
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Session name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={car && track ? `${car} @ ${track}` : "Session name"}
            maxLength={120}
            className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs"
          />
        </label>

        {error && <div className="text-xs text-status-danger">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="app-outline" size="app-md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="app-primary" size="app-md" onClick={submit} disabled={create.isPending || !canCreate} title={!canCreate ? "Pick a track" : undefined}>
            {create.isPending ? "Creating…" : "Create session"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
