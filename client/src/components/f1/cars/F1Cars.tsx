import { useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { powerUnitGroups, regulations, teams } from "./data";
import { GridView } from "./GridView";
import { TableView } from "./TableView";
import type { ViewMode } from "./types";
import { teamBrand } from "./utils";

export function F1Cars() {
  const [view, setView] = useState<ViewMode>("grid");
  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-lg border border-app-border overflow-hidden">
          <Button
            onClick={() => setView("table")}
            title={m.label_table_view()}
            className={`px-2.5 py-1.5 transition-colors ${view === "table" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M3 15h18M9 3v18" />
            </svg>
          </Button>
          <Button
            onClick={() => setView("grid")}
            title={m.label_grid_view()}
            className={`px-2.5 py-1.5 transition-colors ${view === "grid" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </Button>
        </div>
      </div>
      {view === "grid" ? <GridView /> : <TableView />}
      <div>
        <h2 className="text-sm font-semibold text-app-text/90 uppercase tracking-wider mb-3">{m.f1cars_regulations()}</h2>
        <div className="grid grid-cols-2 gap-3 @3xl/workspace:grid-cols-4">
          {Object.entries(regulations).map(([key, value]) => (
            <div key={key} className="bg-app-surface-alt/20 rounded-lg p-3">
              <div className="text-app-caption text-app-text/90 uppercase tracking-wider mb-1">{key.replace(/([A-Z])/g, " $1").trim()}</div>
              <div className="text-xs text-app-text/90 font-medium">{value}</div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h2 className="text-sm font-semibold text-app-text/90 uppercase tracking-wider mb-3">{m.f1cars_power_units()}</h2>
        <div className="grid grid-cols-1 gap-3 @3xl/workspace:grid-cols-3">
          {powerUnitGroups.map((pu) => (
            <div key={pu.name} className="bg-app-surface-alt/20 rounded-lg p-3">
              <div className="text-sm font-semibold text-app-text/90 mb-2">{pu.name}</div>
              <div className="space-y-1">
                {pu.teams.map((name) => {
                  const team = teams.find((tm) => tm.name === name)!;
                  return (
                    <div key={name} data-team-brand={teamBrand(team)} className="flex items-center gap-2 text-xs">
                      <span className="brand-color-dot w-2 h-2 rounded-full shrink-0" />
                      <span className="text-app-text/90">{team.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
