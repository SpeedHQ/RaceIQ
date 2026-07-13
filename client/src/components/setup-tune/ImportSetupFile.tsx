import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { useSetupFiles, useImportTuneFile } from "../../hooks/queries";
import { getCategoriesForGame } from "./SetupTuneForm";

/** Page for importing a setup file from the user's Documents folder.
 *  The server walks the game's Setups directory (/<car>/<track>/<name>.json)
 *  and returns the list; the user picks one, associates it with a known car
 *  ordinal, and the server reads + stores the JSON as a tune. */
export function ImportSetupFile({
  gameId,
  routePrefix,
  gameLabel,
  cars,
}: {
  gameId: "acc" | "ac-evo";
  routePrefix: string;
  gameLabel: string;
  cars: { ordinal: number; name: string }[];
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useSetupFiles(gameId);
  const importMut = useImportTuneFile();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [carOrdinal, setCarOrdinal] = useState<number>(cars[0]?.ordinal ?? 0);
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("Me");
  const [carFilter, setCarFilter] = useState("");
  const categories = useMemo(() => getCategoriesForGame(gameId), [gameId]);
  const [category, setCategory] = useState<string>("race");

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
    const finalName = name || selectedPath.split(/[\\/]/).pop()?.replace(/\.json$/i, "") || "Imported";
    importMut.mutate(
      { gameId, filePath: selectedPath, name: finalName, author, carOrdinal, category },
      { onSuccess: () => navigate({ to: `${routePrefix}/setups` }) },
    );
  };

  return (
    <div className="flex-1 overflow-auto p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-app-text">Import {gameLabel} Setup</h1>
          <p className="text-xs text-app-text-muted">
            Pick a setup from your Documents folder. {data?.baseDir ? <span className="font-mono text-[10px]">{data.baseDir}</span> : null}
          </p>
        </div>
        <Button type="button" variant="app-outline" size="app-sm" onClick={() => navigate({ to: `${routePrefix}/setups` })}>
          Cancel
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-app-text-muted text-sm">Scanning setups...</div>
      ) : !data?.baseDir ? (
        <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-4 text-sm text-app-text-muted">
          <p>Could not find your {gameLabel} Setups folder.</p>
          <p className="mt-2 text-[11px]">
            Expected under <code className="font-mono">Documents/{gameId === "acc" ? "Assetto Corsa Competizione" : "Assetto Corsa EVO"}/Setups</code>.
            Launch the game once to have it created, then try again.
          </p>
        </div>
      ) : filteredCarEntries.length === 0 ? (
        <div className="text-center py-12 text-app-text-muted text-sm">
          No setup files found.
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_1fr] gap-4">
          <div className="rounded-lg bg-app-surface ring-1 ring-app-border overflow-hidden flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-app-border">
              <input
                type="text"
                placeholder="Filter car model..."
                value={carFilter}
                onChange={(e) => setCarFilter(e.target.value)}
                className="w-full bg-app-bg border border-app-border rounded px-2 py-1 text-xs text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
              />
            </div>
            <div className="overflow-auto max-h-96">
              {filteredCarEntries.map(([carModel, files]) => (
                <div key={carModel} className="border-b border-app-border last:border-0">
                  <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-app-text-muted bg-app-bg/50">
                    {carModel}
                  </div>
                  {files.map((f) => (
                    <button
                      key={f.absolutePath}
                      type="button"
                      onClick={() => {
                        setSelectedPath(f.absolutePath);
                        if (!name) setName(f.fileName.replace(/\.json$/i, ""));
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                        selectedPath === f.absolutePath
                          ? "bg-app-accent/20 text-app-accent"
                          : "text-app-text hover:bg-app-surface"
                      }`}
                    >
                      <div className="truncate">{f.fileName}</div>
                      <div className="text-[10px] text-app-text-muted truncate">{f.trackName}</div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-4 space-y-3">
            {selectedPath ? (
              <>
                <div className="space-y-1">
                  <span className="text-[10px] font-semibold uppercase text-app-text-muted">Selected</span>
                  <div className="text-[11px] font-mono text-app-text-secondary break-all">{selectedPath}</div>
                </div>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-app-text-muted">Name</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                  />
                </label>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-app-text-muted">Author</span>
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                  />
                </label>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-app-text-muted">Car</span>
                  <select
                    value={carOrdinal}
                    onChange={(e) => setCarOrdinal(Number(e.target.value))}
                    className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                  >
                    {cars.map((c) => (
                      <option key={c.ordinal} value={c.ordinal}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-app-text-muted">Category</span>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                  >
                    {categories.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </label>
                {importMut.error && (
                  <div className="text-[10px] text-red-400">
                    {(importMut.error as Error).message}
                  </div>
                )}
                <div className="flex justify-end pt-2">
                  <Button
                    type="button"
                    variant="app-primary"
                    size="app-sm"
                    onClick={doImport}
                    disabled={!selectedPath || importMut.isPending}
                  >
                    {importMut.isPending ? "Importing..." : "Import Setup"}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-app-text-muted">Select a setup file to continue.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
