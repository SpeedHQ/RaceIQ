import { teams } from "./data";
import { TeamCard } from "./TeamCard";

export function GridView() {
  return (
    <div className="grid grid-cols-1 gap-3 @3xl/workspace:grid-cols-2">
      {teams.map((team) => (
        <TeamCard key={team.id} team={team} />
      ))}
    </div>
  );
}
