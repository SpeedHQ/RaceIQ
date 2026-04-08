import { useState } from "react";
import { Table, TBody, TD, TH, THead, TRow } from "../ui/AppTable";

interface F1Driver {
  name: string;
  number: number;
  nationality: string;
}

/** In-game performance ratings (1-100 scale, derived from game data) */
interface CarStats {
  overallRating: number;
  pace: number;
  straightLineSpeed: number;
  cornerSpeed: number;
  braking: number;
  traction: number;
  aeroEfficiency: number;
  reliability: number;
}

interface F1Team {
  id: number;
  name: string;
  fullName: string;
  chassis: string;
  powerUnit: string;
  teamPrincipal: string;
  base: string;
  color: string;
  image: string;
  drivers: [F1Driver, F1Driver];
  stats: CarStats;
}

const teams: F1Team[] = [
  {
    id: 8,
    name: "McLaren",
    fullName: "McLaren Formula 1 Team",
    chassis: "MCL39",
    powerUnit: "Mercedes",
    teamPrincipal: "Andrea Stella",
    base: "Woking, UK",
    color: "#FF8000",
    image: "/car-images/f1/mclaren.png",
    drivers: [
      { name: "Lando Norris", number: 4, nationality: "GB" },
      { name: "Oscar Piastri", number: 81, nationality: "AU" },
    ],
    stats: {
      overallRating: 95,
      pace: 96,
      straightLineSpeed: 93,
      cornerSpeed: 97,
      braking: 94,
      traction: 95,
      aeroEfficiency: 96,
      reliability: 92,
    },
  },
  {
    id: 1,
    name: "Ferrari",
    fullName: "Scuderia Ferrari HP",
    chassis: "SF-25",
    powerUnit: "Ferrari",
    teamPrincipal: "Frederic Vasseur",
    base: "Maranello, Italy",
    color: "#E8002D",
    image: "/car-images/f1/ferrari.png",
    drivers: [
      { name: "Charles Leclerc", number: 16, nationality: "MC" },
      { name: "Lewis Hamilton", number: 44, nationality: "GB" },
    ],
    stats: {
      overallRating: 94,
      pace: 95,
      straightLineSpeed: 95,
      cornerSpeed: 93,
      braking: 93,
      traction: 94,
      aeroEfficiency: 93,
      reliability: 94,
    },
  },
  {
    id: 2,
    name: "Red Bull Racing",
    fullName: "Oracle Red Bull Racing",
    chassis: "RB21",
    powerUnit: "Honda RBPT",
    teamPrincipal: "Christian Horner",
    base: "Milton Keynes, UK",
    color: "#3671C6",
    image: "/car-images/f1/redbullracing.png",
    drivers: [
      { name: "Max Verstappen", number: 1, nationality: "NL" },
      { name: "Liam Lawson", number: 30, nationality: "NZ" },
    ],
    stats: {
      overallRating: 93,
      pace: 94,
      straightLineSpeed: 94,
      cornerSpeed: 94,
      braking: 92,
      traction: 93,
      aeroEfficiency: 95,
      reliability: 90,
    },
  },
  {
    id: 0,
    name: "Mercedes",
    fullName: "Mercedes-AMG Petronas F1 Team",
    chassis: "W16",
    powerUnit: "Mercedes",
    teamPrincipal: "Toto Wolff",
    base: "Brackley, UK",
    color: "#27F4D2",
    image: "/car-images/f1/mercedes.png",
    drivers: [
      { name: "George Russell", number: 63, nationality: "GB" },
      { name: "Andrea Kimi Antonelli", number: 12, nationality: "IT" },
    ],
    stats: {
      overallRating: 91,
      pace: 92,
      straightLineSpeed: 93,
      cornerSpeed: 90,
      braking: 91,
      traction: 90,
      aeroEfficiency: 91,
      reliability: 93,
    },
  },
  {
    id: 4,
    name: "Aston Martin",
    fullName: "Aston Martin Aramco F1 Team",
    chassis: "AMR25",
    powerUnit: "Mercedes",
    teamPrincipal: "Andy Cowell",
    base: "Silverstone, UK",
    color: "#229971",
    image: "/car-images/f1/astonmartin.png",
    drivers: [
      { name: "Fernando Alonso", number: 14, nationality: "ES" },
      { name: "Lance Stroll", number: 18, nationality: "CA" },
    ],
    stats: {
      overallRating: 85,
      pace: 85,
      straightLineSpeed: 86,
      cornerSpeed: 84,
      braking: 85,
      traction: 84,
      aeroEfficiency: 86,
      reliability: 88,
    },
  },
  {
    id: 5,
    name: "Alpine",
    fullName: "BWT Alpine F1 Team",
    chassis: "A525",
    powerUnit: "Mercedes",
    teamPrincipal: "Oliver Oakes",
    base: "Enstone, UK",
    color: "#FF87BC",
    image: "/car-images/f1/alpine.png",
    drivers: [
      { name: "Pierre Gasly", number: 10, nationality: "FR" },
      { name: "Jack Doohan", number: 7, nationality: "AU" },
    ],
    stats: {
      overallRating: 82,
      pace: 82,
      straightLineSpeed: 83,
      cornerSpeed: 81,
      braking: 82,
      traction: 81,
      aeroEfficiency: 82,
      reliability: 85,
    },
  },
  {
    id: 7,
    name: "Haas",
    fullName: "MoneyGram Haas F1 Team",
    chassis: "VF-25",
    powerUnit: "Ferrari",
    teamPrincipal: "Ayao Komatsu",
    base: "Kannapolis, USA",
    color: "#B6BABD",
    image: "/car-images/f1/haas.png",
    drivers: [
      { name: "Oliver Bearman", number: 87, nationality: "GB" },
      { name: "Esteban Ocon", number: 31, nationality: "FR" },
    ],
    stats: {
      overallRating: 83,
      pace: 83,
      straightLineSpeed: 84,
      cornerSpeed: 82,
      braking: 83,
      traction: 82,
      aeroEfficiency: 81,
      reliability: 86,
    },
  },
  {
    id: 6,
    name: "Racing Bulls",
    fullName: "Visa Cash App Racing Bulls",
    chassis: "VCARB 02",
    powerUnit: "Honda RBPT",
    teamPrincipal: "Laurent Mekies",
    base: "Faenza, Italy",
    color: "#6692FF",
    image: "/car-images/f1/racingbulls.png",
    drivers: [
      { name: "Yuki Tsunoda", number: 22, nationality: "JP" },
      { name: "Isack Hadjar", number: 6, nationality: "FR" },
    ],
    stats: {
      overallRating: 84,
      pace: 84,
      straightLineSpeed: 85,
      cornerSpeed: 83,
      braking: 84,
      traction: 83,
      aeroEfficiency: 83,
      reliability: 87,
    },
  },
  {
    id: 3,
    name: "Williams",
    fullName: "Williams Racing",
    chassis: "FW47",
    powerUnit: "Mercedes",
    teamPrincipal: "James Vowles",
    base: "Grove, UK",
    color: "#1868DB",
    image: "/car-images/f1/williams.png",
    drivers: [
      { name: "Alexander Albon", number: 23, nationality: "TH" },
      { name: "Carlos Sainz", number: 55, nationality: "ES" },
    ],
    stats: {
      overallRating: 81,
      pace: 81,
      straightLineSpeed: 84,
      cornerSpeed: 79,
      braking: 80,
      traction: 80,
      aeroEfficiency: 80,
      reliability: 84,
    },
  },
  {
    id: 9,
    name: "Sauber",
    fullName: "Stake F1 Team Kick Sauber",
    chassis: "C45",
    powerUnit: "Ferrari",
    teamPrincipal: "Mattia Binotto",
    base: "Hinwil, Switzerland",
    color: "#52E252",
    image: "/car-images/f1/sauber.png",
    drivers: [
      { name: "Nico Hulkenberg", number: 27, nationality: "DE" },
      { name: "Gabriel Bortoleto", number: 5, nationality: "BR" },
    ],
    stats: {
      overallRating: 78,
      pace: 78,
      straightLineSpeed: 80,
      cornerSpeed: 76,
      braking: 78,
      traction: 77,
      aeroEfficiency: 77,
      reliability: 83,
    },
  },
];

/** F1 2025 Technical Regulations — shared across all cars */
const regulations = {
  engine: "1.6L V6 Turbo Hybrid",
  totalPower: "~1,000+ HP (ICE + ERS)",
  ers: "MGU-K + MGU-H, 4 MJ deployment/lap",
  weight: "798 kg minimum",
  fuelCapacity: "110 kg max",
  gearbox: "8-speed sequential + reverse",
  tyres: "Pirelli (C1-C5, Intermediates, Wets)",
  drs: "Drag Reduction System (rear wing)",
};

const powerUnitGroups = [
  { name: "Mercedes", teams: ["Mercedes", "McLaren", "Aston Martin", "Williams", "Alpine"] },
  { name: "Ferrari", teams: ["Ferrari", "Haas", "Sauber"] },
  { name: "Honda RBPT", teams: ["Red Bull Racing", "Racing Bulls"] },
];

const statLabels: { key: keyof CarStats; label: string }[] = [
  { key: "overallRating", label: "Overall" },
  { key: "pace", label: "Pace" },
  { key: "straightLineSpeed", label: "Straight Speed" },
  { key: "cornerSpeed", label: "Corner Speed" },
  { key: "braking", label: "Braking" },
  { key: "traction", label: "Traction" },
  { key: "aeroEfficiency", label: "Aero Efficiency" },
  { key: "reliability", label: "Reliability" },
];

type ViewMode = "grid" | "table";

function getRatingColor(value: number): string {
  if (value >= 93) return "text-emerald-400";
  if (value >= 88) return "text-cyan-400";
  if (value >= 83) return "text-yellow-400";
  return "text-orange-400";
}

export function F1Cars() {
  const [view, setView] = useState<ViewMode>("grid");

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-lg border border-app-border overflow-hidden">
          <button
            onClick={() => setView("table")}
            title="Table view"
            className={`px-2.5 py-1.5 transition-colors ${view === "table" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90-muted hover:text-app-text/90"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>
            </svg>
          </button>
          <button
            onClick={() => setView("grid")}
            title="Grid view"
            className={`px-2.5 py-1.5 transition-colors ${view === "grid" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90-muted hover:text-app-text/90"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </button>
        </div>
      </div>

      {view === "grid" ? <GridView /> : <TableView />}

      {/* Regulation Specs */}
      <div>
        <h2 className="text-sm font-semibold text-app-text/90 uppercase tracking-wider mb-3">
          2025 Technical Regulations
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Object.entries(regulations).map(([key, value]) => (
            <div key={key} className="bg-app-surface-alt/20 rounded-lg p-3">
              <div className="text-[10px] text-app-text/90-dim uppercase tracking-wider mb-1">
                {key.replace(/([A-Z])/g, " $1").trim()}
              </div>
              <div className="text-xs text-app-text/90 font-medium">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Power Unit Groups */}
      <div>
        <h2 className="text-sm font-semibold text-app-text/90 uppercase tracking-wider mb-3">
          Power Unit Suppliers
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {powerUnitGroups.map((pu) => (
            <div
              key={pu.name}
              className="bg-app-surface-alt/20 rounded-lg p-3"
            >
              <div className="text-sm font-semibold text-app-text/90 mb-2">
                {pu.name}
              </div>
              <div className="space-y-1">
                {pu.teams.map((t) => {
                  const team = teams.find((tm) => tm.name === t)!;
                  return (
                    <div key={t} className="flex items-center gap-2 text-xs">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: team.color }}
                      />
                      <span className="text-app-text/90">
                        {team.name}
                      </span>
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

function GridView() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {teams.map((team) => (
        <TeamCard key={team.id} team={team} />
      ))}
    </div>
  );
}

function TeamCard({ team }: { team: F1Team }) {
  return (
    <div className="bg-app-surface-alt/20 rounded-lg overflow-hidden">
      {/* Team color bar */}
      <div className="h-1" style={{ backgroundColor: team.color }} />
      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold text-app-text/90">
                {team.name}
              </div>
              <span
                className={`text-sm font-mono font-bold ${getRatingColor(team.stats.overallRating)}`}
              >
                {team.stats.overallRating}
              </span>
            </div>
            <div className="text-xs text-app-text/90-dim">{team.fullName}</div>
          </div>
          <div
            className="text-xs font-mono px-2 py-0.5 rounded"
            style={{
              backgroundColor: team.color + "20",
              color: team.color,
            }}
          >
            {team.chassis}
          </div>
        </div>

        {/* Car image */}
        <div className="h-20 flex items-center justify-center">
          <img
            src={team.image}
            alt={`${team.name} ${team.chassis}`}
            className="h-full object-contain"
            loading="lazy"
          />
        </div>

        {/* Drivers */}
        <div className="grid grid-cols-2 gap-2">
          {team.drivers.map((driver) => (
            <div
              key={driver.number}
              className="bg-app-surface-alt/30 rounded px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span
                  className="text-lg font-mono font-bold leading-none"
                  style={{ color: team.color }}
                >
                  {driver.number}
                </span>
                <div>
                  <div className="text-sm font-medium text-app-text/90 leading-tight">
                    {driver.name}
                  </div>
                  <div className="text-[10px] text-app-text/90-dim uppercase">
                    {driver.nationality}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Performance Stats — numbers only */}
        <div className="grid grid-cols-4 gap-x-3 gap-y-2">
          {statLabels
            .filter((s) => s.key !== "overallRating")
            .map(({ key, label }) => (
              <div key={key} className="text-center">
                <div className={`text-base font-mono font-bold leading-none ${getRatingColor(team.stats[key])}`}>
                  {team.stats[key]}
                </div>
                <div className="text-[9px] text-app-text/90-dim uppercase tracking-wider mt-1">
                  {label}
                </div>
              </div>
            ))}
        </div>

        {/* Info row */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs border-t border-app-border/30 pt-2">
          <div className="flex justify-between">
            <span className="text-app-text/90-dim">Power Unit</span>
            <span className="text-app-text/90">{team.powerUnit}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-app-text/90-dim">Base</span>
            <span className="text-app-text/90">{team.base}</span>
          </div>
          <div className="flex justify-between col-span-2">
            <span className="text-app-text/90-dim">Team Principal</span>
            <span className="text-app-text/90">
              {team.teamPrincipal}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TableView() {
  return (
    <Table>
      <THead>
        <TH>Team</TH>
        <TH>Chassis</TH>
        <TH>PU</TH>
        <TH>Drivers</TH>
        <TH className="text-right px-2">OVR</TH>
        <TH className="text-right px-2">PAC</TH>
        <TH className="text-right px-2">SPD</TH>
        <TH className="text-right px-2">COR</TH>
        <TH className="text-right px-2">BRK</TH>
        <TH className="text-right px-2">TRC</TH>
        <TH className="text-right px-2">AER</TH>
        <TH className="text-right px-2">REL</TH>
      </THead>
      <TBody>
        {teams.map((team) => (
          <TRow key={team.id}>
            <TD>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: team.color }} />
                <span className="font-medium text-app-text/90">{team.name}</span>
              </div>
            </TD>
            <TD>
              <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: team.color + "20", color: team.color }}>
                {team.chassis}
              </span>
            </TD>
            <TD className="text-app-text/90 text-xs">{team.powerUnit}</TD>
            <TD>
              <div className="flex flex-col gap-0.5">
                {team.drivers.map((d) => (
                  <span key={d.number} className="text-xs text-app-text/90">
                    {d.name}
                    <span className="ml-1 font-mono" style={{ color: team.color }}>#{d.number}</span>
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

function StatCell({ value, bold }: { value: number; bold?: boolean }) {
  return (
    <TD className="text-right px-2">
      <span className={`font-mono text-xs ${getRatingColor(value)} ${bold ? "font-bold" : ""}`}>
        {value}
      </span>
    </TD>
  );
}
