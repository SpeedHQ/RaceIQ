import { useState } from "react";
import { CATALOG_CARS, getCatalogCar, getTunesByCar, type CatalogTune, type RaceStrategy, type TuneSettings } from "../data/tune-catalog";

function TuneSettingsPanel({ settings }: { settings: TuneSettings }) {
  const sections: { title: string; rows: [string, string][] }[] = [
    {
      title: "Tires",
      rows: [
        ["Front Pressure", `${settings.tires.frontPressure.toFixed(2)} bar`],
        ["Rear Pressure", `${settings.tires.rearPressure.toFixed(2)} bar`],
      ],
    },
    {
      title: "Gearing",
      rows: [
        ["Final Drive", settings.gearing.finalDrive.toFixed(2)],
        ...(settings.gearing.description ? [["Notes", settings.gearing.description] as [string, string]] : []),
      ],
    },
    {
      title: "Alignment",
      rows: [
        ["Front Camber", `${settings.alignment.frontCamber.toFixed(1)}°`],
        ["Rear Camber", `${settings.alignment.rearCamber.toFixed(1)}°`],
        ["Front Toe", `${settings.alignment.frontToe.toFixed(1)}°`],
        ["Rear Toe", `${settings.alignment.rearToe.toFixed(1)}°`],
        ...(settings.alignment.frontCaster != null
          ? [["Front Caster", `${settings.alignment.frontCaster.toFixed(1)}°`] as [string, string]]
          : []),
      ],
    },
    {
      title: "Anti-Roll Bars",
      rows: [
        ["Front", settings.antiRollBars.front.toFixed(1)],
        ["Rear", settings.antiRollBars.rear.toFixed(1)],
      ],
    },
    {
      title: "Springs",
      rows: [
        ["Front Rate", `${settings.springs.frontRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`],
        ["Rear Rate", `${settings.springs.rearRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`],
        ["Front Height", `${settings.springs.frontHeight.toFixed(1)} cm`],
        ["Rear Height", `${settings.springs.rearHeight.toFixed(1)} cm`],
      ],
    },
    {
      title: "Damping",
      rows: [
        ["Front Rebound", settings.damping.frontRebound.toFixed(1)],
        ["Rear Rebound", settings.damping.rearRebound.toFixed(1)],
        ["Front Bump", settings.damping.frontBump.toFixed(1)],
        ["Rear Bump", settings.damping.rearBump.toFixed(1)],
      ],
    },
    {
      title: "Aero",
      rows: [
        ["Front Downforce", `${settings.aero.frontDownforce} ${settings.aero.unit ?? "kgf"}`],
        ["Rear Downforce", `${settings.aero.rearDownforce} ${settings.aero.unit ?? "kgf"}`],
      ],
    },
    {
      title: "Differential",
      rows: [
        ["Rear Accel", `${settings.differential.rearAccel}%`],
        ["Rear Decel", `${settings.differential.rearDecel}%`],
        ...(settings.differential.frontAccel != null
          ? [["Front Accel", `${settings.differential.frontAccel}%`] as [string, string]]
          : []),
        ...(settings.differential.frontDecel != null
          ? [["Front Decel", `${settings.differential.frontDecel}%`] as [string, string]]
          : []),
      ],
    },
    {
      title: "Brakes",
      rows: [
        ["Balance", `${settings.brakes.balance}%`],
        ["Pressure", `${settings.brakes.pressure}%`],
      ],
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-2xl">
      {sections.map((section) => (
        <div key={section.title} className="rounded-lg bg-app-bg/60 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
            {section.title}
          </h4>
          <div className="space-y-0">
            {section.rows.map(([label, value]) => (
              <div key={label} className="flex justify-between text-xs gap-2">
                <span className="text-app-text-muted whitespace-nowrap">{label}</span>
                <span className="text-app-text font-mono whitespace-nowrap" style={label === "Notes" ? { whiteSpace: "normal", textAlign: "right" } : undefined}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const CONDITION_COLORS: Record<string, string> = {
  Dry: "bg-amber-500/20 text-amber-400",
  Wet: "bg-cyan-500/20 text-cyan-400",
};

function StrategyPanel({ strategies, tuneId }: { strategies: RaceStrategy[]; tuneId: string }) {
  const [activeCondition, setActiveCondition] = useState(strategies[0].condition);
  const strategy = strategies.find((s) => s.condition === activeCondition) ?? strategies[0];

  return (
    <div className="rounded-lg bg-app-bg/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent">
          Race Strategy
        </h4>
        <div className="flex gap-1">
          {strategies.map((s) => (
            <button
              key={`${tuneId}-${s.condition}`}
              onClick={() => setActiveCondition(s.condition)}
              className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded transition-colors ${
                activeCondition === s.condition
                  ? CONDITION_COLORS[s.condition]
                  : "text-app-text-muted hover:text-app-text-secondary"
              }`}
            >
              {s.condition}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">{strategy.totalLaps}</div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">Laps</div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">{strategy.fuelLoadPercent}%</div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">Fuel Load</div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">{strategy.pitStops}</div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">Pit Stops</div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">{strategy.tireCompound}</div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">Tire</div>
        </div>
      </div>
      {strategy.pitLaps && strategy.pitLaps.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs mb-2">
          <span className="text-app-text-muted">Pit on lap:</span>
          {strategy.pitLaps.map((lap) => (
            <span key={lap} className="font-mono px-1.5 py-0.5 rounded bg-app-surface/60 text-app-text ring-1 ring-app-border">
              {lap}
            </span>
          ))}
        </div>
      )}
      {strategy.notes && (
        <p className="text-xs text-app-text-secondary">{strategy.notes}</p>
      )}
    </div>
  );
}

const CATEGORY_ICONS: Record<string, JSX.Element> = {
  circuit: (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20M2 12h20" />
    </svg>
  ),
  wet: (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l-3.5 11a4 4 0 1 0 7 0L12 2z" />
    </svg>
  ),
  "low-drag": (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  ),
  stable: (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V2M2 12l10-10 10 10" />
    </svg>
  ),
  "track-specific": (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1 1 18 0z" /><circle cx="12" cy="10" r="3" />
    </svg>
  ),
};

const CATEGORY_LABELS: Record<string, string> = {
  circuit: "Circuit",
  wet: "Wet",
  "low-drag": "Low Drag",
  stable: "Stable",
  "track-specific": "Track Specific",
};

const CATEGORY_COLORS: Record<string, string> = {
  circuit: "bg-blue-500/20 text-blue-400",
  wet: "bg-cyan-500/20 text-cyan-400",
  "low-drag": "bg-red-500/20 text-red-400",
  stable: "bg-green-500/20 text-green-400",
  "track-specific": "bg-orange-500/20 text-orange-400",
};

function TuneCard({ tune, isExpanded, onToggle }: { tune: CatalogTune; isExpanded: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-xl bg-app-surface/40 ring-1 ring-app-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-app-surface/60 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-app-text">{tune.name}</span>
              <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${CATEGORY_COLORS[tune.category]}`}>
                {CATEGORY_ICONS[tune.category]}{CATEGORY_LABELS[tune.category]}
              </span>
            </div>
            <p className={`text-xs text-app-text-muted mt-0.5 ${isExpanded ? "" : "line-clamp-1"}`}>{tune.description}</p>
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-app-text-muted shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-app-border max-w-2xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-green-400 mb-1">Strengths</h4>
              <ul className="space-y-0.5">
                {tune.strengths.map((s) => (
                  <li key={s} className="text-xs text-app-text-secondary flex items-start gap-1.5">
                    <span className="text-green-400 mt-0.5">+</span> {s}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-1">Weaknesses</h4>
              <ul className="space-y-0.5">
                {tune.weaknesses.map((w) => (
                  <li key={w} className="text-xs text-app-text-secondary flex items-start gap-1.5">
                    <span className="text-red-400 mt-0.5">-</span> {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {tune.bestTracks && tune.bestTracks.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted mb-1">
                Best Tracks
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {tune.bestTracks.map((t) => (
                  <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg/60 text-app-text-secondary ring-1 ring-app-border">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {tune.strategies && tune.strategies.length > 0 && (
            <StrategyPanel strategies={tune.strategies} tuneId={tune.id} />
          )}

          <TuneSettingsPanel settings={tune.settings} />

          <div className="text-[10px] text-app-text-muted pt-1">
            by {tune.author}
          </div>
        </div>
      )}
    </div>
  );
}

export function TuneCatalog() {
  const [selectedCar, setSelectedCar] = useState(CATALOG_CARS[0].ordinal);
  const [expandedTune, setExpandedTune] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [carSearch, setCarSearch] = useState("");
  const [carDropdownOpen, setCarDropdownOpen] = useState(false);

  const filteredCars = carSearch
    ? CATALOG_CARS.filter((c) => c.name.toLowerCase().includes(carSearch.toLowerCase()))
    : CATALOG_CARS;

  const car = getCatalogCar(selectedCar);
  const tunes = getTunesByCar(selectedCar);
  const filteredTunes = categoryFilter ? tunes.filter((t) => t.category === categoryFilter) : tunes;

  const categories = [...new Set(tunes.map((t) => t.category))];

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-app-text">Tune Catalog</h1>
            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
              Stock Spec
            </span>
            {car && (
              <span className="text-[10px] font-mono text-app-text-muted">
                {car.class} {car.pi}
              </span>
            )}
          </div>
          <p className="text-xs text-app-text-muted">No upgrades — tuning only setups for GT3 spec events</p>
        </div>

        <div className="relative">
          <input
            type="text"
            value={carDropdownOpen ? carSearch : (getCatalogCar(selectedCar)?.name ?? "")}
            onChange={(e) => {
              setCarSearch(e.target.value);
              setCarDropdownOpen(true);
            }}
            onFocus={() => {
              setCarDropdownOpen(true);
              setCarSearch("");
            }}
            onBlur={() => setTimeout(() => setCarDropdownOpen(false), 150)}
            placeholder="Search cars..."
            className="bg-app-surface/60 text-app-text text-xs rounded-lg px-3 py-1.5 ring-1 ring-app-border focus:outline-none focus:ring-app-accent w-56"
          />
          {carDropdownOpen && (
            <div className="absolute right-0 mt-1 w-56 max-h-60 overflow-auto rounded-lg bg-app-surface ring-1 ring-app-border z-50 shadow-lg">
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
                  }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${
                    selectedCar === c.ordinal ? "text-app-accent" : "text-app-text"
                  }`}
                >
                  {c.name}
                </button>
              ))}
              {filteredCars.length === 0 && (
                <div className="px-3 py-2 text-xs text-app-text-muted">No cars found</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setCategoryFilter(null)}
          className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${
            categoryFilter === null
              ? "bg-app-accent/20 text-app-accent"
              : "text-app-text-muted hover:text-app-text-secondary"
          }`}
        >
          All ({tunes.length})
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
            className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${
              categoryFilter === cat
                ? CATEGORY_COLORS[cat]
                : "text-app-text-muted hover:text-app-text-secondary"
            }`}
          >
            <span className="inline-flex items-center gap-1">{CATEGORY_ICONS[cat]}{CATEGORY_LABELS[cat]}</span> ({tunes.filter((t) => t.category === cat).length})
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {filteredTunes.map((tune) => (
          <TuneCard
            key={tune.id}
            tune={tune}
            isExpanded={expandedTune === tune.id}
            onToggle={() => setExpandedTune(expandedTune === tune.id ? null : tune.id)}
          />
        ))}
      </div>

      {filteredTunes.length === 0 && (
        <div className="text-center py-12 text-app-text-muted text-sm">
          No tunes found for this filter.
        </div>
      )}
    </div>
  );
}
