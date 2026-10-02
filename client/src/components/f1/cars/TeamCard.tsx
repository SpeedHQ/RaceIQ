import { m } from "@/paraglide/messages";
import { statLabels } from "./data";
import type { F1Team } from "./types";
import { getRatingColor, teamBrand } from "./utils";

export function TeamCard({ team }: { team: F1Team }) {
  return (
    <div data-team-brand={teamBrand(team)} className="bg-app-surface-alt/20 rounded-lg overflow-hidden">
      <div className="brand-color-strip h-1" />
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold text-app-text/90">{team.name}</div>
              <span className={`text-sm font-mono font-bold ${getRatingColor(team.stats.overallRating)}`}>{team.stats.overallRating}</span>
            </div>
            <div className="text-xs text-app-text/90">{team.fullName}</div>
          </div>
          <div className="brand-color-badge text-xs font-mono px-2 py-0.5 rounded">{team.chassis}</div>
        </div>
        <div className="h-20 flex items-center justify-center">
          <img src={team.image} alt={`${team.name} ${team.chassis}`} className="h-full object-contain" loading="lazy" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {team.drivers.map((driver) => (
            <div key={driver.number} className="bg-app-surface-alt/30 rounded px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="brand-color-text text-lg font-mono font-bold leading-none">{driver.number}</span>
                <div>
                  <div className="text-sm font-medium text-app-text/90 leading-tight">{driver.name}</div>
                  <div className="text-app-caption text-app-text/90 uppercase">{driver.nationality}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-x-3 gap-y-2">
          {statLabels
            .filter((s) => s.key !== "overallRating")
            .map(({ key, label }) => (
              <div key={key} className="text-center">
                <div className={`text-base font-mono font-bold leading-none ${getRatingColor(team.stats[key])}`}>{team.stats[key]}</div>
                <div className="text-app-micro text-app-text/90 uppercase tracking-wider mt-1">{label}</div>
              </div>
            ))}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs border-t border-app-border/30 pt-2">
          <div className="flex justify-between">
            <span className="text-app-text/90">{m.label_power_unit()}</span>
            <span className="text-app-text/90">{team.powerUnit}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-app-text/90">{m.label_base()}</span>
            <span className="text-app-text/90">{team.base}</span>
          </div>
          <div className="flex justify-between col-span-2">
            <span className="text-app-text/90">{m.label_team_principal()}</span>
            <span className="text-app-text/90">{team.teamPrincipal}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
