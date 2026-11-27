import { useEffect, useRef, useState } from "react";
import { assignment, fittedModel, listModels, loadLibrary, neutralFit, saveAssignment, type Assignment, type Fit, type Model } from "./library";
import { FitPreview } from "./FitPreview";

import { ShrinkDialog, type ShrinkLabels } from "./ShrinkDialog";
export interface ModelMessages extends ShrinkLabels {
  model_picker: () => string;
  model_automatic: () => string;
  model_import: () => string;
  model_apply: () => string;
  model_fit: () => string;
  model_guides: () => string;
  model_wheelbase: () => string;
  model_front_track: () => string;
  model_rear_track: () => string;
  model_rotation: () => string;
  model_offset: () => string;
  model_scale: () => string;
  model_top: () => string;
  model_side: () => string;
  model_front: () => string;
  model_file_error: () => string;
  model_save_error: () => string;
  model_no_id: () => string;
  common_cancel: () => string;
  label_importing: () => string;
  spectate_model_unavailable: () => string;
}
const control = "cursor-pointer rounded-sm border border-app-border bg-app-surface px-2 py-1 text-app-text disabled:cursor-not-allowed disabled:opacity-50";
export function ModelSelector({ game, car, automatic, m, onApply, onClose }: { game: string; car?: string; automatic: Model; m: ModelMessages; onApply: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [saved] = useState(() => assignment(game, car));
  const [draft, setDraft] = useState<Assignment | null>(saved);
  const [entries, setEntries] = useState(listModels);
  const [view, setView] = useState<"top" | "side" | "front">("top");
  const [file, setFile] = useState<File>();
  const busy = !!file;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const model = fittedModel(automatic, draft);
  useEffect(() => {
    dialog.current?.showModal();
    void loadLibrary()
      .then(() => setEntries(listModels()))
      .catch(() => setError(m.model_save_error()));
  }, [m]);
  const fitNumber = (key: keyof Fit, label: string, step: number, min: number, max: number) => (
    <label key={key} className="grid gap-1">
      {label}
      <input
        type="number"
        required
        min={min}
        max={max}
        step={step}
        aria-label={label}
        className={control + " w-full"}
        defaultValue={draft!.fit[key]}
        onChange={(e) => {
          const n = e.currentTarget.valueAsNumber;
          if (Number.isFinite(n) && n >= min && n <= max) setDraft({ ...draft!, fit: { ...draft!.fit, [key]: n } });
        }}
      />
    </label>
  );
  return (
    <dialog
      ref={dialog}
      onCancel={e => {if (e.target === e.currentTarget) onClose();}}
      aria-label={m.model_picker()}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[min(30rem,95vw)] overflow-auto rounded border border-app-border bg-app-surface p-4 text-app-text backdrop:bg-black/50"
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!car || busy || (draft && !ready)) return;
          try {
            saveAssignment(game, car, draft);
            onApply();
            onClose();
          } catch {
            setError(m.model_save_error());
          }
        }}
      >
        <label className="grid gap-1 font-semibold">
          {m.model_picker()}
          <select
            className={control}
            value={draft?.id ?? ""}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value;
              setError("");
              setDraft(!id ? null : id === saved?.id ? saved : { id, fit: neutralFit });
            }}
          >
            <option value="">{m.model_automatic()}</option>
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <button className={control} type="button" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? m.label_importing() : m.model_import()}
        </button>
        <input
          hidden
          ref={input}
          type="file"
          accept=".glb"
          onChange={(e) => {setFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; setError('');}}
        />
        <FitPreview key={model.modelPath} model={model} view={view} label={m.model_fit()} errorLabel={m.spectate_model_unavailable()} onReady={setReady} />
        <div className="flex gap-1">
          {(["top", "side", "front"] as const).map((v) => (
            <button key={v} type="button" className={control} aria-pressed={view === v} onClick={() => setView(v)}>
              {m[`model_${v}`]()}
            </button>
          ))}
        </div>
        {draft && (
          <details key={draft.id}>
            <summary className="cursor-pointer py-2">{m.model_fit()}</summary>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <span className="col-span-3">{m.model_rotation()} (°)</span>
              {fitNumber("roll", "X (°)", 0.1, -360, 360)}
              {fitNumber("yaw", "Y (°)", 0.1, -360, 360)}
              {fitNumber("pitch", "Z (°)", 0.1, -360, 360)}
              <span className="col-span-3">{m.model_offset()} (m)</span>
              {fitNumber("x", "X (m)", 0.01, -20, 20)}
              {fitNumber("y", "Y (m)", 0.01, -20, 20)}
              {fitNumber("z", "Z (m)", 0.01, -20, 20)}
              {fitNumber("scale", m.model_scale(), 0.01, 0.01, 100)}
            </div>
            <details>
              <summary className="cursor-pointer py-2">{m.model_guides()}</summary>
              <div className="grid gap-2">
                {(["wheelbase", "frontTrack", "rearTrack"] as const).map((key, i) => (
                  <label key={key} className="flex items-center justify-between gap-2">
                    {[m.model_wheelbase(), m.model_front_track(), m.model_rear_track()][i]} (m)
                    <input
                      type="number"
                      min="0.01"
                      max="20"
                      step="any"
                      className={control + " w-24"}
                      placeholder={String(2 * [automatic.halfWheelbase, automatic.halfFrontTrack, automatic.halfRearTrack][i]!)}
                      defaultValue={draft[key]}
                      onChange={(e) => {
                        const n = e.currentTarget.valueAsNumber;
                        if (!e.target.value || e.target.validity.valid) setDraft({ ...draft, [key]: Number.isFinite(n) ? n : undefined });
                      }}
                    />
                  </label>
                ))}
              </div>
            </details>
          </details>
        )}
        {!car && <p>{m.model_no_id()}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={control} onClick={onClose}>
            {m.common_cancel()}
          </button>
          <button className={control} type="submit" disabled={!car || busy || (!!draft && !ready)}>
            {m.model_apply()}
          </button>
        </div>
      </form>
      {file && <ShrinkDialog file={file} copyName={file.name.replace(/\.glb$/i,'')} m={m} close={() => setFile(undefined)} saved={id => {setEntries(listModels()); setDraft({id, fit:neutralFit}); setFile(undefined);}}/>}
    </dialog>
  );
}
