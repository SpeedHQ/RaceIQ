import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import {
  useUserTunes,
  useDeleteTune,
  useDuplicateTune,
} from "../../hooks/queries";
import type { GameId } from "@shared/types";

/** Unified "My Tunes" list page for ACC / AC-EVO. Game-specific fields (car
 *  list, route prefixes) are supplied by the route layers; this component
 *  handles layout, filtering, and actions. */
export function SetupTunesPage({
  gameId,
  routePrefix,
  gameLabel,
  cars,
}: {
  gameId: GameId;
  routePrefix: string;
  gameLabel: string;
  cars: { ordinal: number; name: string; class?: string }[];
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selectedCar, setSelectedCar] = useState<number | null>(null);

  const { data: userTunes = [], isLoading } = useUserTunes(gameId);
  const deleteMut = useDeleteTune();
  const duplicateMut = useDuplicateTune();

  const carNameMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of cars) m.set(c.ordinal, c.name);
    return m;
  }, [cars]);

  const filtered = useMemo(
    () => userTunes.filter((t) => selectedCar == null || t.carOrdinal === selectedCar),
    [userTunes, selectedCar],
  );

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-app-text">{gameLabel} Tunes</h1>
            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
              {filtered.length}
            </span>
          </div>
          <p className="text-xs text-app-text-muted">
            Manage saved setups, duplicate, or import from your {gameLabel} Documents folder.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="app-outline"
            size="app-sm"
            className="bg-cyan-900/50 !border-cyan-700 text-app-accent hover:bg-cyan-900/70"
            onClick={() => navigate({ to: `${routePrefix}/tunes/new` })}
          >
            + New Tune
          </Button>
          <Link
            to={`${routePrefix}/tunes/import` as string}
            className="text-xs px-3 py-1.5 rounded border border-app-border text-app-text-secondary hover:text-app-text transition-colors no-underline"
          >
            Import from file
          </Link>
          <select
            value={selectedCar ?? ""}
            onChange={(e) => setSelectedCar(e.target.value ? Number(e.target.value) : null)}
            className="bg-app-surface text-app-text text-xs rounded-lg px-2 py-1.5 border border-app-border focus:outline-none focus:ring-1 focus:ring-app-accent w-48"
          >
            <option value="">All cars</option>
            {cars.map((c) => (
              <option key={c.ordinal} value={c.ordinal}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        {isLoading ? (
          <div className="text-center py-12 text-app-text-muted text-sm">Loading tunes...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-app-text-muted text-sm">
            <p>No {gameLabel} tunes yet.</p>
            <p className="mt-1">
              <Link to={`${routePrefix}/tunes/new` as string} className="text-app-accent hover:underline">Create a new tune</Link>
              {" or "}
              <Link to={`${routePrefix}/tunes/import` as string} className="text-app-accent hover:underline">import from file</Link>.
            </p>
          </div>
        ) : (
          filtered.map((t) => (
            <SetupTuneCard
              key={t.id}
              tune={t}
              carName={carNameMap.get(t.carOrdinal)}
              isExpanded={expanded === t.id}
              onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
              onEdit={() => navigate({ to: `${routePrefix}/tunes/edit/${t.id}` })}
              onDuplicate={() => duplicateMut.mutate(t.id)}
              onDelete={() => deleteMut.mutate(t.id)}
              isBusy={deleteMut.isPending || duplicateMut.isPending}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SetupTuneCard({
  tune,
  carName,
  isExpanded,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
  isBusy,
}: {
  tune: {
    id: number;
    name: string;
    author: string;
    carOrdinal: number;
    category: string;
    description: string;
    source?: string;
    settings?: unknown;
  };
  carName?: string;
  isExpanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  isBusy: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="rounded-xl bg-app-surface ring-1 ring-app-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-app-surface transition-colors"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-app-text">{tune.name}</span>
            <span className="text-[10px] font-mono text-app-text-muted">
              {carName ?? `Car #${tune.carOrdinal}`}
            </span>
            {tune.source === "imported-file" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">Imported</span>
            )}
          </div>
          <p className={`text-xs text-app-text-muted mt-0.5 ${isExpanded ? "" : "line-clamp-1"}`}>
            {tune.description || "No description"}
          </p>
        </div>
        <svg className={`w-4 h-4 text-app-text-muted shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isExpanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-app-border">
          <div className="flex items-center gap-2 pt-3 flex-wrap">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
            >
              Edit
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
              disabled={isBusy}
              className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 disabled:opacity-50 transition-colors"
            >
              Duplicate
            </button>
            {!confirmDelete ? (
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
              >
                Delete
              </button>
            ) : (
              <span className="flex items-center gap-1">
                <span className="text-[10px] text-red-400">Sure?</span>
                <button onClick={(e) => { e.stopPropagation(); onDelete(); }} disabled={isBusy} className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-red-600/30 text-red-300 hover:bg-red-600/50 disabled:opacity-50 transition-colors">{isBusy ? "..." : "Yes"}</button>
                <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }} className="text-[10px] font-semibold uppercase px-2 py-1 rounded text-app-text-muted hover:text-app-text transition-colors">No</button>
              </span>
            )}
          </div>
          {tune.settings != null && (
            <pre className="text-[11px] font-mono bg-app-bg rounded p-2 max-h-72 overflow-auto text-app-text-secondary whitespace-pre-wrap break-all">
              {JSON.stringify(tune.settings, null, 2)}
            </pre>
          )}
          <div className="text-[10px] text-app-text-muted">by {tune.author}</div>
        </div>
      )}
    </div>
  );
}
