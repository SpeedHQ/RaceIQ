import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { m } from "@/paraglide/messages";
import { teams } from "./data";
import { StatCell } from "./StatCell";
import { teamBrand } from "./utils";

export function TableView() {
  return (
    <Table>
      <THead>
        <TH>{m.label_team()}</TH>
        <TH>{m.label_chassis()}</TH>
        <TH>PU</TH>
        <TH>{m.label_drivers()}</TH>
        <TH align="end">OVR</TH>
        <TH align="end">PAC</TH>
        <TH align="end">SPD</TH>
        <TH align="end">COR</TH>
        <TH align="end">BRK</TH>
        <TH align="end">TRC</TH>
        <TH align="end">AER</TH>
        <TH align="end">REL</TH>
      </THead>
      <TBody>
        {teams.map((team) => (
          <TRow key={team.id}>
            <TD>
              <div className="flex items-center gap-2">
                <span data-team-brand={teamBrand(team)} className="brand-color-dot w-2 h-2 rounded-full shrink-0" />
                <span className="font-medium text-app-text/90">{team.name}</span>
              </div>
            </TD>
            <TD>
              <span data-team-brand={teamBrand(team)} className="brand-color-badge font-mono text-xs px-1.5 py-0.5 rounded">
                {team.chassis}
              </span>
            </TD>
            <TD tone="primary">{team.powerUnit}</TD>
            <TD>
              <div className="flex flex-col gap-0.5">
                {team.drivers.map((d) => (
                  <span key={d.number} className="text-xs text-app-text/90">
                    {d.name}
                    <span data-team-brand={teamBrand(team)} className="brand-color-text ml-1 font-mono">
                      #{d.number}
                    </span>
                  </span>
                ))}
              </div>
            </TD>
            <StatCell value={team.stats.overallRating} bold />
            <StatCell value={team.stats.pace} />
            <StatCell value={team.stats.straightLineSpeed} />
            <StatCell value={team.stats.cornerSpeed} />
            <StatCell value={team.stats.braking} />
            <StatCell value={team.stats.traction} />
            <StatCell value={team.stats.aeroEfficiency} />
            <StatCell value={team.stats.reliability} />
          </TRow>
        ))}
      </TBody>
    </Table>
  );
}
