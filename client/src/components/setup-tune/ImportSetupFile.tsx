import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppInput } from "@/components/ui/AppInput";
import { m } from "@/paraglide/messages";
import { useImportTuneFile, useInspectCarSetup, useSetupFiles } from "../../hooks/setup-queries";
import { Button } from "../ui/button";
import { getCategoriesForGame } from "./SetupTuneForm";

/** Imports game setup files into the tune catalog, from the game folder or an uploaded AC Evo binary. */
export function ImportSetupFile({ gameId, routePrefix, gameLabel, cars, initialFile, onClose }: { gameId: "acc" | "ac-evo"; routePrefix: string; gameLabel: string; cars: { ordinal: number; name: string }[]; initialFile?: File; onClose?: () => void }) {
  const navigate = useNavigate();
  const { data, isLoading } = useSetupFiles(gameId);
  const importMut = useImportTuneFile();
  const { mutateAsync: inspect } = useInspectCarSetup();
  const [upload, setUpload] = useState<{ contentBase64: string; carName: string | null } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(initialFile?.name ?? null);
  const [carOrdinal, setCarOrdinal] = useState<number>(initialFile ? 0 : cars[0]?.ordinal ?? 0);
  const [name, setName] = useState(initialFile?.name.replace(/\.carsetup$/i, "") ?? "");
  const [author, setAuthor] = useState("Me");
  const [carFilter, setCarFilter] = useState("");
  const categories = useMemo(() => getCategoriesForGame(gameId), [gameId]);
  const [category, setCategory] = useState<string>("race");

  useEffect(() => {
    if (!initialFile) return;
    let active = true;
    void (async () => {
      try {
        const bytes = new Uint8Array(await initialFile.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const contentBase64 = btoa(binary);
        const info = await inspect(contentBase64);
        if (active) setUpload({ contentBase64, carName: info.carName });
      } catch (error) {
        if (active) setUploadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { active = false; };
  }, [initialFile, inspect]);

  useEffect(() => {
    if (!upload?.carName) return;
    const car = cars.find((candidate) => candidate.name === upload.carName);
    if (car) setCarOrdinal(car.ordinal);
  }, [upload, cars]);

  const grouped = useMemo(() => {
    if (!data?.files) return new Map<string, { trackName: string; fileName: string; absolutePath: string }[]>();
    const byCar = new Map<string, { trackName: string; fileName: string; absolutePath: string }[]>();
    for (const f of data.files) {
      if (!byCar.has(f.carModel)) byCar.set(f.carModel, []);
      byCar.get(f.carModel)!.push({ trackName: f.trackName, fileName: f.fileName, absolutePath: f.absolutePath });
    }
    return byCar;
  }, [data]);

  const filteredCarEntries = useMemo(() => {
    const entries = [...grouped.entries()];
    if (!carFilter) return entries;
    const q = carFilter.toLowerCase();
    return entries.filter(([car]) => car.toLowerCase().includes(q));
  }, [grouped, carFilter]);

  const doImport = () => {
    if (!selectedPath) return;
    const finalName =
      name ||
      selectedPath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.(json|carsetup)$/i, "") ||
      m.setup_tune_imported_fallback();
    const source = initialFile ? { fileName: initialFile.name, contentBase64: upload?.contentBase64 } : { filePath: selectedPath };
    importMut.mutate({ gameId, ...source, name: finalName, author, carOrdinal, category }, { onSuccess: () => {
      onClose?.();
      void navigate({ to: `${routePrefix}/setups` });
    } });
  };

  return (
    <div className="flex-1 overflow-auto p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-app-title font-bold text-app-text">
            {m.import_title_prefix()} {gameLabel} {m.import_title_suffix()}
          </h1>
          <p className="text-app-subtext text-app-text-muted">
            {initialFile ? initialFile.name : <>{m.import_pick_setup()} {data?.baseDir ? <span className="font-mono text-app-compact">{data.baseDir}</span> : null}</>}
          </p>
        </div>
        <Button variant="app-outline" size="app-sm" onClick={() => onClose ? onClose() : navigate({ to: `${routePrefix}/setups` })}>
          {m.common_cancel()}
        </Button>
      </div>

      {uploadError ? (
        <div role="alert" className="text-status-danger">{uploadError}</div>
      ) : initialFile && !upload ? (
        <div className="text-app-text-muted">{m.session_reading()}</div>
      ) : !initialFile && isLoading ? (
        <div className="text-center py-12 text-app-text-muted text-app-subtext">{m.import_scanning()}</div>
      ) : !initialFile && !data?.baseDir ? (
        <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-4 text-app-subtext text-app-text-muted">
          <p>
            {m.import_folder_not_found_prefix()} {gameLabel} {m.import_folder_not_found_suffix()}
          </p>
          <p className="mt-2 text-app-compact">
            {m.import_expected_path()} <code className="font-mono">Documents/{gameId === "acc" ? "Assetto Corsa Competizione" : "Assetto Corsa EVO"}/Setups</code>.{m.import_launch_game()}
          </p>
        </div>
      ) : !initialFile && filteredCarEntries.length === 0 ? (
        <div className="text-center py-12 text-app-text-muted text-sm">{m.import_no_files()}</div>
      ) : (
        <div className={initialFile ? "" : "grid grid-cols-1 sm:grid-cols-2 gap-4"}>
          {!initialFile && <div className="rounded-lg bg-app-surface ring-1 ring-app-border overflow-hidden flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-app-border">
              <AppInput type="text" placeholder={m.import_filter_car()} value={carFilter} onChange={(e) => setCarFilter(e.target.value)} className="w-full" />
            </div>
            <div className="overflow-auto max-h-96">
              {filteredCarEntries.map(([carModel, files]) => (
                <div key={carModel} className="border-b border-app-border last:border-0">
                  <div className="px-3 py-1.5 text-app-caption font-semibold uppercase tracking-wider text-app-text-muted bg-app-bg/50">{carModel}</div>
                  {files.map((f) => (
                    <Button
                      key={f.absolutePath}
                      type="button"
                      onClick={() => {
                        setSelectedPath(f.absolutePath);
                        if (!name) setName(f.fileName.replace(/\.(json|carsetup)$/i, ""));
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                        selectedPath === f.absolutePath ? "bg-app-accent/20 text-app-accent" : "text-app-text hover:bg-app-surface-hover"
                      }`}
                    >
                      <div className="truncate">{f.fileName}</div>
                      <div className="text-app-caption text-app-text-muted truncate">{f.trackName}</div>
                    </Button>
                  ))}
                </div>
              ))}
            </div>
          </div>}

          <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-4 space-y-3">
            {selectedPath ? (
              <>
                <div className="space-y-1">
                  <span className="text-app-caption font-semibold uppercase text-app-text-muted">{m.import_selected()}</span>
                  <div className="text-app-compact font-mono text-app-text-secondary break-all">{selectedPath}</div>
                </div>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-app-text-muted">{m.tune_form_name()}</span>
                  <AppInput type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
                </label>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-app-text-muted">{m.label_author()}</span>
                  <AppInput type="text" value={author} onChange={(e) => setAuthor(e.target.value)} className="w-full" />
                </label>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-app-text-muted">{m.label_car()}</span>
                  <select
                    value={carOrdinal}
                    onChange={(e) => setCarOrdinal(Number(e.target.value))}
                    className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                  >
                    {initialFile && <option value={0}>{m.tune_form_select_car_placeholder()}</option>}
                    {cars.map((c) => (
                      <option key={c.ordinal} value={c.ordinal}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-app-text-muted">{m.label_category()}</span>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                  >
                    {categories.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                {importMut.error && <div className="text-app-caption text-status-danger">{(importMut.error as Error).message}</div>}
                <div className="flex justify-end pt-2">
                  <Button variant="app-primary" size="app-sm" onClick={doImport} disabled={!selectedPath || importMut.isPending || (initialFile != null && (!upload || carOrdinal === 0))}>
                    {importMut.isPending ? m.label_importing() : m.import_import_setup()}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-app-text-muted">{m.import_select_continue()}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
