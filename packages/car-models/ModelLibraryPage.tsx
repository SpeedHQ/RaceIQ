import { useEffect, useRef, useState } from "react";
import { importModel, listModels, loadLibrary } from "./library";

interface Labels {
  model_library: () => string;
  model_builtin: () => string;
  model_imported: () => string;
  model_import: () => string;
  label_importing: () => string;
  model_file_error: () => string;
  model_save_error: () => string;
}

export function ModelLibraryPage({ m, loadConfigs }: { m: Labels; loadConfigs: () => Promise<void> }) {
  const [models, setModels] = useState(listModels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([loadConfigs(), loadLibrary()]).then(() => {
      if (active) setModels(listModels());
    }).catch(() => { if (active) setError(m.model_save_error()); });
    return () => { active = false; };
  }, [loadConfigs, m]);
  async function add(file: File) {
    setBusy(true);
    setError("");
    try {
      await importModel(file);
      setModels(listModels());
    } catch (reason) {
      setError(reason instanceof DOMException ? m.model_save_error() : m.model_file_error());
    } finally {
      setBusy(false);
    }
  }
  return <section className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold text-app-text">{m.model_library()}</h1>
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className="cursor-pointer rounded border border-app-border bg-app-surface px-4 py-2 text-sm font-semibold text-app-text hover:border-app-accent disabled:opacity-50">{busy ? m.label_importing() : m.model_import()}</button>
      <input ref={input} hidden type="file" accept=".glb" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void add(file);
      }} />
    </header>
    {error && <p role="alert" className="text-sm text-app-text">{error}</p>}
    <ul className="divide-y divide-app-border rounded border border-app-border bg-app-surface">
      {models.map(model => <li key={model.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
        <span className="min-w-0 break-words font-medium text-app-text">{model.name}</span>
        <span className="shrink-0 text-xs text-app-text-secondary">{model.config.importedBody ? m.model_imported() : m.model_builtin()}</span>
      </li>)}
    </ul>
  </section>;
}
