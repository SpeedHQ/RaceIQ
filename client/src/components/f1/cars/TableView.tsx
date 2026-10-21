import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { m } from "@/paraglide/messages";
import { teams } from "./data";
import { StatCell } from "./StatCell";
import { teamBrand } from "./utils";

export function TableView() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{m.label_team()}</TableHead>
          <TableHead>{m.label_chassis()}</TableHead>
          <TableHead>PU</TableHead>
          <TableHead>{m.label_drivers()}</TableHead>
          <TableHead className="text-right">OVR</TableHead>
          <TableHead className="text-right">PAC</TableHead>
          <TableHead className="text-right">SPD</TableHead>
          <TableHead className="text-right">COR</TableHead>
          <TableHead className="text-right">BRK</TableHead>
          <TableHead className="text-right">TRC</TableHead>
          <TableHead className="text-right">AER</TableHead>
          <TableHead className="text-right">REL</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {teams.map((team) => (
          <TableRow key={team.id}>
            <TableCell>
              <div className="flex items-center gap-2">
                <span data-team-brand={teamBrand(team)} className="brand-color-dot w-2 h-2 rounded-full shrink-0" />
                <span className="font-medium text-app-text/90">{team.name}</span>
              </div>
            </TableCell>
            <TableCell>
              <span data-team-brand={teamBrand(team)} className="brand-color-badge font-mono text-xs px-1.5 py-0.5 rounded">{team.chassis}</span>
            </TableCell>
            <TableCell>{team.powerUnit}</TableCell>
            <TableCell>
              <div className="flex flex-col gap-0.5">
                {team.drivers.map((d) => (
                  <span key={d.number} className="text-xs text-app-text/90">
                    {d.name}<span data-team-brand={teamBrand(team)} className="brand-color-text ml-1 font-mono">#{d.number}</span>
                  </span>
                ))}
              </div>
            </TableCell>
            <StatCell value={team.stats.overallRating} bold />
            <StatCell value={team.stats.pace} />
            <StatCell value={team.stats.straightLineSpeed} />
            <StatCell value={team.stats.cornerSpeed} />
            <StatCell value={team.stats.braking} />
            <StatCell value={team.stats.traction} />
            <StatCell value={team.stats.aeroEfficiency} />
            <StatCell value={team.stats.reliability} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
