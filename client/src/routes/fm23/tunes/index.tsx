import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "../../../components/ui/button";
import { useState, useMemo } from "react";
import {
  CATALOG_CARS,
  getCatalogCar,
} from "../../../data/tune-catalog";
import {
  useUserTunes,
  useDeleteTune,
  useTuneAssignments,
  useDeleteTuneAssignment,
} from "../../../hooks/queries";
import {
  useAllCars,
  UserTuneCard,
} from "../../../components/TuneForm";

function MyTunesPage() {
  const navigate = useNavigate();
  const [expandedTune, setExpandedTune] = useState<string | null>(null);
  const [selectedCar, setSelectedCar] = useState<number | null>(null);
  const [carSearch, setCarSearch] = useState("");
  const [carDropdownOpen, setCarDropdownOpen] = useState(false);

  const { data: userTunes = [], isLoading } = useUserTunes();
  const { data: assignments = [] } = useTuneAssignments();
  const { data: allCarsForNames = [] } = useAllCars();
  const carNameMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of allCarsForNames) map.set(c.ordinal, c.name);
    return map;
  }, [allCarsForNames]);
  const deleteTuneMut = useDeleteTune();
  const deleteAssignment = useDeleteTuneAssignment();

  const filteredCars = carSearch
    ? CATALOG_CARS.filter((c) => c.name.toLowerCase().includes(carSearch.toLowerCase()))
    : CATALOG_CARS;

  const filteredUserTunes = useMemo(() => {
    return userTunes.filter((t) => {
      if (selectedCar != null && t.carOrdinal !== selectedCar) return false;
      return true;
    });
  }, [userTunes, selectedCar]);

  const filteredAssignments = assignments.filter(
    (a) => selectedCar == null || a.carOrdinal === selectedCar,
  );

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-app-text">My Tunes</h1>
            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
              {filteredUserTunes.length}
            </span>
          </div>
          <p className="text-xs text-app-text-muted">
            Manage your saved tunes and track assignments
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="app-outline" size="app-sm" className="bg-cyan-900/50 !border-cyan-700 text-app-accent hover:bg-cyan-900/70" onClick={() => navigate({ to: "/fm23/tunes/new" })}>
            + New Tune
          </Button>
          <Link
            to="/fm23/tunes/catalog"
            className="text-xs px-3 py-1.5 rounded border border-app-border text-app-text-secondary hover:text-app-text transition-colors no-underline"
          >
            Catalog
          </Link>
          <div className="relative">
            <input
              type="text"
              value={carDropdownOpen ? carSearch : selectedCar != null ? (getCatalogCar(selectedCar)?.name ?? `Car ${selectedCar}`) : ""}
              onChange={(e) => { setCarSearch(e.target.value); setCarDropdownOpen(true); }}
              onFocus={() => { setCarDropdownOpen(true); setCarSearch(""); }}
              onBlur={() => setTimeout(() => setCarDropdownOpen(false), 150)}
              placeholder="Filter by car..."
              className="bg-app-surface text-app-text text-xs rounded-lg px-3 py-1.5 border border-app-border focus:outline-none focus:ring-1 focus:ring-app-accent w-48"
            />
            {carDropdownOpen && (
              <div className="absolute right-0 mt-1 w-56 max-h-60 overflow-auto rounded-lg bg-app-surface border border-app-border z-50 shadow-lg">
                {!carSearch && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setSelectedCar(null); setCarSearch(""); setCarDropdownOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${selectedCar == null ? "text-app-accent" : "text-app-text"}`}
                  >
                    All Cars
                  </button>
                )}
                {filteredCars.map((c) => (
                  <button
                    key={c.ordinal}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setSelectedCar(c.ordinal); setCarSearch(""); setCarDropdownOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${selectedCar === c.ordinal ? "text-app-accent" : "text-app-text"}`}
                  >
                    {c.name}
                  </button>
                ))}
                {filteredCars.length === 0 && <div className="px-3 py-2 text-xs text-app-text-muted">No cars found</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tune list */}
      <div className="space-y-2">
        {isLoading ? (
          <div className="text-center py-12 text-app-text-muted text-sm">Loading tunes...</div>
        ) : filteredUserTunes.length === 0 ? (
          <div className="text-center py-12 text-app-text-muted text-sm">
            <p>No user tunes yet.</p>
            <p className="mt-1">Create a new tune or <Link to="/fm23/tunes/catalog" className="text-app-accent hover:underline">clone one from the catalog</Link>.</p>
          </div>
        ) : (
          filteredUserTunes.map((tune) => (
            <UserTuneCard
              key={tune.id}
              tune={tune}
              carName={carNameMap.get(tune.carOrdinal)}
              isExpanded={expandedTune === `user-${tune.id}`}
              onToggle={() => setExpandedTune(expandedTune === `user-${tune.id}` ? null : `user-${tune.id}`)}
              onEdit={() => navigate({ to: `/fm23/tunes/edit/${tune.id}` })}
              onDelete={() => deleteTuneMut.mutate(tune.id)}
              isDeleting={deleteTuneMut.isPending}
            />
          ))
        )}
      </div>

      {/* Tune Assignments */}
      {filteredAssignments.length > 0 && (
        <div className="pt-4 border-t border-app-border">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted mb-2">
            Active Tune Assignments
          </h3>
          <div className="space-y-1">
            {filteredAssignments.map((a) => (
              <div key={`${a.carOrdinal}-${a.trackOrdinal}`} className="flex items-center justify-between text-xs px-3 py-2 rounded-lg bg-app-bg">
                <span className="text-app-text-secondary">Car {a.carOrdinal} / Track {a.trackOrdinal}</span>
                <div className="flex items-center gap-2">
                  <span className="text-app-text font-medium">{a.tuneName ?? `Tune #${a.tuneId}`}</span>
                  <button
                    onClick={() => deleteAssignment.mutate({ carOrdinal: a.carOrdinal, trackOrdinal: a.trackOrdinal })}
                    className="text-red-400 hover:text-red-300 transition-colors"
                    title="Remove assignment"
                  >
                    &times;
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/fm23/tunes/")({
  component: MyTunesPage,
});
