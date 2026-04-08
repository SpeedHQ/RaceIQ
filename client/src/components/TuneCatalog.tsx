import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CATALOG_CARS,
  TUNE_CATALOG,
  getCatalogCar,
  type CatalogTune,
} from "../data/tune-catalog";
import type { Tune } from "@shared/types";
import {
  useUserTunes,
  useCatalogTunes,
  useCreateTune,
  useUpdateTune,
  useCloneCatalogTune,
} from "../hooks/queries";
import { CatalogTuneCard } from "./tune/CatalogTuneCard";
import { TuneFormDialog, type TuneFormData } from "./tune/TuneFormDialog";
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
} from "./tune/tune-constants.tsx";

const PAGE_SIZE = 10;

export function TuneCatalog() {
  // UI state
  const [selectedCar, setSelectedCar] = useState<number | null>(null);
  const [expandedTune, setExpandedTune] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [carSearch, setCarSearch] = useState("");
  const [carDropdownOpen, setCarDropdownOpen] = useState(false);
  const [trackSearch, setTrackSearch] = useState("");
  const [catalogPage, setCatalogPage] = useState(0);

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editingTune, setEditingTune] = useState<Tune | null>(null);

  // API queries
  const { data: userTunes = [] } = useUserTunes();
  const { data: apiCatalogTunes = [] } = useCatalogTunes();

  // Mutations
  const createTune = useCreateTune();
  const updateTune = useUpdateTune();
  const cloneTune = useCloneCatalogTune();

  // Use local catalog as fallback, API catalog when available
  const catalogTunes: CatalogTune[] =
    apiCatalogTunes.length > 0 ? apiCatalogTunes : TUNE_CATALOG;

  // Car filter
  const filteredCars = carSearch
    ? CATALOG_CARS.filter((c) =>
        c.name.toLowerCase().includes(carSearch.toLowerCase()),
      )
    : CATALOG_CARS;

  const car = selectedCar != null ? getCatalogCar(selectedCar) : null;

  // Filter catalog tunes
  const allCatalogTunes =
    selectedCar != null
      ? catalogTunes.filter((t) => t.carOrdinal === selectedCar)
      : catalogTunes;
  const trackQuery = trackSearch.toLowerCase();
  const filteredCatalogTunes = allCatalogTunes.filter((t) => {
    if (categoryFilter && t.category !== categoryFilter) return false;
    if (
      trackQuery &&
      !t.bestTracks?.some((tr) => tr.toLowerCase().includes(trackQuery))
    )
      return false;
    return true;
  });

  // Paginate catalog tunes
  const totalCatalogPages = Math.ceil(
    filteredCatalogTunes.length / PAGE_SIZE,
  );
  const paginatedCatalogTunes = filteredCatalogTunes.slice(
    catalogPage * PAGE_SIZE,
    (catalogPage + 1) * PAGE_SIZE,
  );

  const categories = [
    ...new Set(allCatalogTunes.map((t) => t.category)),
  ];

  // Handlers
  const handleCreateSubmit = (data: TuneFormData) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createTune.mutate(data as any, {
      onSuccess: () => {
        setFormOpen(false);
      },
    });
  };

  const handleEditSubmit = (data: TuneFormData) => {
    if (!editingTune) return;
    updateTune.mutate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: editingTune.id, ...data } as any,
      {
        onSuccess: () => {
          setEditingTune(null);
          setFormOpen(false);
        },
      },
    );
  };

  const handleClone = (catalogId: string) => {
    cloneTune.mutate(catalogId);
  };

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-app-text">Tune Catalog</h1>
            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
              {selectedCar != null
                ? "Stock Spec"
                : `${catalogTunes.length} Tunes`}
            </span>
            {car && (
              <span className="text-[10px] font-mono text-app-text-muted">
                {car.class} {car.pi}
              </span>
            )}
          </div>
          <p className="text-xs text-app-text-muted">
            Reference tunes — clone to your collection to edit
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            to="/fm23/tunes"
            className="text-xs px-3 py-1.5 rounded bg-app-accent text-white hover:bg-app-accent/80 transition-colors flex items-center gap-1.5 no-underline"
          >
            My Tunes
            {userTunes.length > 0 && (
              <span className="bg-white/20 rounded-full px-1.5 py-0 text-[10px] font-bold">
                {userTunes.length}
              </span>
            )}
          </Link>
          <input
            type="text"
            value={trackSearch}
            onChange={(e) => {
              setTrackSearch(e.target.value);
              setCatalogPage(0);
            }}
            placeholder="Search tracks..."
            className="bg-app-dropdown text-app-text text-xs rounded-lg px-3 py-1.5 border border-app-border-input focus:outline-none focus:ring-1 focus:ring-app-accent w-36"
          />
          <div className="relative">
            <input
              type="text"
              value={
                carDropdownOpen
                  ? carSearch
                  : selectedCar != null
                    ? (getCatalogCar(selectedCar)?.name ?? `Car ${selectedCar}`)
                    : ""
              }
              onChange={(e) => {
                setCarSearch(e.target.value);
                setCarDropdownOpen(true);
              }}
              onFocus={() => {
                setCarDropdownOpen(true);
                setCarSearch("");
              }}
              onBlur={() =>
                setTimeout(() => setCarDropdownOpen(false), 150)
              }
              placeholder="Filter by car..."
              className="bg-app-surface-alt text-app-text text-xs rounded-lg px-3 py-1.5 border border-app-border-input focus:outline-none focus:ring-1 focus:ring-app-accent w-48"
            />
            {carDropdownOpen && (
              <div className="absolute right-0 mt-1 w-56 max-h-60 overflow-auto rounded-lg bg-app-dropdown border border-app-border z-50 shadow-lg">
                {!carSearch && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelectedCar(null);
                      setExpandedTune(null);
                      setCategoryFilter(null);
                      setCarSearch("");
                      setCarDropdownOpen(false);
                      setCatalogPage(0);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${
                      selectedCar == null
                        ? "text-app-accent"
                        : "text-app-text"
                    }`}
                  >
                    All Cars
                  </button>
                )}
                {filteredCars.map((c) => (
                  <button
                    key={c.ordinal}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelectedCar(c.ordinal);
                      setExpandedTune(null);
                      setCategoryFilter(null);
                      setCarSearch("");
                      setCarDropdownOpen(false);
                      setCatalogPage(0);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${
                      selectedCar === c.ordinal
                        ? "text-app-accent"
                        : "text-app-text"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
                {filteredCars.length === 0 && (
                  <div className="px-3 py-2 text-xs text-app-text-muted">
                    No cars found
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Category filters */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setCategoryFilter(null)}
          className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${
            categoryFilter === null
              ? "bg-app-accent/20 text-app-accent"
              : "text-app-text-muted hover:text-app-text-secondary"
          }`}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => {
              setCategoryFilter(categoryFilter === cat ? null : cat);
              setCatalogPage(0);
            }}
            className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${
              categoryFilter === cat
                ? (CATEGORY_COLORS[cat] ?? "bg-gray-500/20 text-gray-400")
                : "text-app-text-muted hover:text-app-text-secondary"
            }`}
          >
            <span className="inline-flex items-center gap-1">
              {CATEGORY_ICONS[cat]}
              {CATEGORY_LABELS[cat] ?? cat}
            </span>
          </button>
        ))}
      </div>

      {/* Catalog Content */}
      <div className="space-y-2">
        {paginatedCatalogTunes.map((tune) => (
          <CatalogTuneCard
            key={tune.id}
            tune={tune}
            isExpanded={expandedTune === `catalog-${tune.id}`}
            onToggle={() =>
              setExpandedTune(
                expandedTune === `catalog-${tune.id}`
                  ? null
                  : `catalog-${tune.id}`,
              )
            }
            showCar={selectedCar == null}
            onClone={() => handleClone(tune.id)}
            isCloning={cloneTune.isPending}
          />
        ))}
      </div>

      {filteredCatalogTunes.length === 0 && (
        <div className="text-center py-12 text-app-text-muted text-sm">
          No catalog tunes found for this filter.
        </div>
      )}

      {totalCatalogPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => setCatalogPage((p) => Math.max(0, p - 1))}
            disabled={catalogPage === 0}
            className="text-xs px-3 py-1 rounded border border-app-border text-app-text-secondary hover:text-app-text disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <span className="text-xs text-app-text-muted">
            {catalogPage + 1} / {totalCatalogPages}
          </span>
          <button
            onClick={() =>
              setCatalogPage((p) =>
                Math.min(totalCatalogPages - 1, p + 1),
              )
            }
            disabled={catalogPage >= totalCatalogPages - 1}
            className="text-xs px-3 py-1 rounded border border-app-border text-app-text-secondary hover:text-app-text disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <TuneFormDialog
        isOpen={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditingTune(null);
        }}
        initialData={
          editingTune
            ? {
                name: editingTune.name,
                author: editingTune.author,
                carOrdinal: editingTune.carOrdinal,
                category: editingTune.category,
                description: editingTune.description,
                settings: editingTune.settings,
              }
            : selectedCar != null
              ? { carOrdinal: selectedCar }
              : undefined
        }
        onSubmit={editingTune ? handleEditSubmit : handleCreateSubmit}
        title={editingTune ? `Edit: ${editingTune.name}` : "Create New Tune"}
        isSubmitting={createTune.isPending || updateTune.isPending}
      />
    </div>
  );
}
