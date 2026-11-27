import { useCallback, useEffect, useRef, useState } from "react";
import { previewShrink, saveModelCopy, type ShrinkResult } from "./library";
import type { ShrinkOptions } from "./shrink";
import { ShrinkComparison } from "./ShrinkComparison";

export interface ShrinkLabels {
  model_optimise: () => string;
  model_texture_limit: () => string;
  model_original: () => string;
  model_output: () => string;
  model_strip: () => string;
  model_remove_parts: () => string;
  model_save_copy: () => string;
  common_cancel: () => string;
  label_importing: () => string;
  model_file_error: () => string;
  model_save_error: () => string;
  spectate_model_unavailable: () => string;
}
const control = "cursor-pointer rounded border border-app-border bg-app-surface px-3 py-2 text-app-text hover:border-app-accent disabled:cursor-not-allowed disabled:opacity-50";
export function ShrinkDialog({ file, copyName, m, close, saved }: { file: File; copyName: string; m: ShrinkLabels; close: () => void; saved: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<ShrinkOptions>({ replayOnly: false, remove: [], textureLimit: 0 });
  const [result, setResult] = useState<ShrinkResult>();
  const [parts, setParts] = useState<ShrinkResult["parts"]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false);
  const rendered = useCallback(
    (ok: boolean) => {
      setReady(ok);
      if (!ok) setError(m.spectate_model_unavailable());
    },
    [m],
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    previewShrink(file, options, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setParts(next.parts);
          setResult(next);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(m.model_file_error());
      });
    return () => controller.abort();
  }, [file, options, m]);
  function change(next: ShrinkOptions) {
    setReady(false);
    setResult(undefined);
    setError("");
    setOptions(next);
  }
  async function save() {
    if (!result || !ready || saving) return;
    setSaving(true);
    try {
      saved(await saveModelCopy(copyName, result.blob));
    } catch {
      setError(m.model_save_error());
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="shrink-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) close();
      }}
      className="m-auto max-h-[90dvh] w-[min(46rem,95vw)] overflow-y-auto rounded border border-app-border bg-app-surface p-4 text-app-text backdrop:bg-black/60"
    >
      <h2 id="shrink-title" className="text-xl font-semibold">
        {m.model_optimise()}: {file.name}
      </h2>
      <fieldset disabled={saving} className="my-4 flex flex-wrap items-center gap-4 text-sm">
        <label>
          {m.model_texture_limit()}{" "}
          <select className={control} value={options.textureLimit} onChange={(e) => change({ ...options, textureLimit: Number(e.target.value) })}>
            <option value={0}>{m.model_original()}</option>
            {[512, 1024, 2048, 4096].map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={options.replayOnly} onChange={(e) => change({ ...options, replayOnly: e.target.checked })} /> {m.model_strip()}
        </label>
        <details className="w-full">
          <summary className="cursor-pointer">{m.model_remove_parts()}</summary>
          <div className="mt-2 grid max-h-40 overflow-auto">
            {parts.map(({ index, name }) => (
              <label key={index}>
                <input
                  type="checkbox"
                  checked={options.remove.includes(index)}
                  onChange={(e) => change({ ...options, remove: e.target.checked ? [...options.remove, index] : options.remove.filter((x) => x !== index) })}
                />{" "}
                {name}
              </label>
            ))}
          </div>
        </details>
      </fieldset>
      {result && (
        <>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span>
              {m.model_original()}: {file.size.toLocaleString()} B
            </span>
            <span>
              {m.model_output()}: {result.blob.size.toLocaleString()} B (
              {new Intl.NumberFormat(undefined, { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 2 }).format(result.blob.size / file.size - 1)})
            </span>
          </div>
          <ShrinkComparison source={file} output={result.blob} label={m.model_optimise()} onReady={rendered} />
        </>
      )}
      {!result && !error && <p role="status">{m.label_importing()}</p>}
      {error && <p role="alert">{error}</p>}
      <footer className="mt-4 flex justify-end gap-2">
        <button type="button" className={control} disabled={saving} onClick={close}>
          {m.common_cancel()}
        </button>
        <button type="button" className={control} disabled={!ready || saving} onClick={save}>
          {m.model_save_copy()}
        </button>
      </footer>
    </dialog>
  );
}
