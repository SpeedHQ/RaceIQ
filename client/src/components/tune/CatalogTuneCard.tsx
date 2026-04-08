import type { CatalogTune } from "../../data/tune-catalog";
import { getCatalogCar } from "../../data/tune-catalog";
import { CATEGORY_COLORS, CATEGORY_ICONS, CATEGORY_LABELS } from "./tune-constants.tsx";
import { TuneSettingsPanel } from "./TuneSettingsPanel";
import { StrategyPanel } from "./StrategyPanel";

export function CatalogTuneCard({
  tune,
  isExpanded,
  onToggle,
  showCar,
  onClone,
  isCloning,
}: {
  tune: CatalogTune;
  isExpanded: boolean;
  onToggle: () => void;
  showCar?: boolean;
  onClone: () => void;
  isCloning: boolean;
}) {
  return (
    <div className="rounded-xl bg-app-surface/85 ring-1 ring-app-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-app-surface transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-app-text">{tune.name}</span>
              {showCar && (
                <span className="text-[10px] font-mono text-app-text-muted">
                  {getCatalogCar(tune.carOrdinal)?.name ??
                    `Car ${tune.carOrdinal}`}
                </span>
              )}
              <span
                className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${CATEGORY_COLORS[tune.category]}`}
              >
                {CATEGORY_ICONS[tune.category]}
                {CATEGORY_LABELS[tune.category]}
              </span>
            </div>
            <p
              className={`text-xs text-app-text-muted mt-0.5 ${isExpanded ? "" : "line-clamp-1"}`}
            >
              {tune.description}
            </p>
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-app-text-muted shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-app-border max-w-2xl">
          <div className="flex items-center gap-2 pt-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClone();
              }}
              disabled={isCloning}
              className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-50 transition-colors"
            >
              {isCloning ? "Cloning..." : "Clone to My Tunes"}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-green-400 mb-1">
                Strengths
              </h4>
              <ul className="space-y-0.5">
                {tune.strengths.map((s) => (
                  <li
                    key={s}
                    className="text-xs text-app-text-secondary flex items-start gap-1.5"
                  >
                    <span className="text-green-400 mt-0.5">+</span> {s}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-1">
                Weaknesses
              </h4>
              <ul className="space-y-0.5">
                {tune.weaknesses.map((w) => (
                  <li
                    key={w}
                    className="text-xs text-app-text-secondary flex items-start gap-1.5"
                  >
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
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg/85 text-app-text-secondary ring-1 ring-app-border"
                  >
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
