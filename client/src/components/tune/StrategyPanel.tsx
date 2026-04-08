import { useState } from "react";
import type { RaceStrategy } from "../../data/tune-catalog";
import { CONDITION_COLORS } from "./tune-constants.tsx";

export function StrategyPanel({
  strategies,
  tuneId,
}: {
  strategies: RaceStrategy[];
  tuneId: string;
}) {
  const [activeCondition, setActiveCondition] = useState(
    strategies[0].condition,
  );
  const strategy =
    strategies.find((s) => s.condition === activeCondition) ?? strategies[0];

  return (
    <div className="rounded-lg bg-app-bg/85 p-3">
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
          <div className="text-sm font-bold text-app-text font-mono leading-tight">
            {strategy.totalLaps}
          </div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">
            Laps
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">
            {strategy.fuelLoadPercent}%
          </div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">
            Fuel Load
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">
            {strategy.pitStops}
          </div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">
            Pit Stops
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">
            {strategy.tireCompound}
          </div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">
            Tire
          </div>
        </div>
      </div>
      {strategy.pitLaps && strategy.pitLaps.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs mb-2">
          <span className="text-app-text-muted">Pit on lap:</span>
          {strategy.pitLaps.map((lap) => (
            <span
              key={lap}
              className="font-mono px-1.5 py-0.5 rounded bg-app-surface text-app-text ring-1 ring-app-border"
            >
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
