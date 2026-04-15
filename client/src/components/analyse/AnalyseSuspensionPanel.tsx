import type { TelemetryPacket } from "@shared/types";
import { Info } from "lucide-react";
import { WheelTable } from "./WheelTable";

interface Props {
  currentPacket: TelemetryPacket;
}

export function AnalyseSuspensionPanel({ currentPacket }: Props) {
  const suspValues = [
    currentPacket.NormSuspensionTravelFL,
    currentPacket.NormSuspensionTravelFR,
    currentPacket.NormSuspensionTravelRL,
    currentPacket.NormSuspensionTravelRR,
  ];
  const suspColor = (v: number) => v < 0.25 ? "#3b82f6" : v < 0.65 ? "#34d399" : v < 0.85 ? "#fbbf24" : "#ef4444";
  const lonLoad = ((suspValues[0] + suspValues[1]) / 2 * 100).toFixed(0);
  const latLoad = ((suspValues[0] + suspValues[2]) / 2 * 100).toFixed(0);
  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;

  // AC Evo: use raw signed mm values instead of normalised %
  const isAcEvo = currentPacket.gameId === "ac-evo";
  const mmValues = isAcEvo ? [
    currentPacket.SuspensionTravelMFL * 1000,
    currentPacket.SuspensionTravelMFR * 1000,
    currentPacket.SuspensionTravelMRL * 1000,
    currentPacket.SuspensionTravelMRR * 1000,
  ] : null;
  const mmColor = (mm: number) => mm > 30 ? "#ef4444" : mm > 15 ? "#fbbf24" : mm > 0 ? "#34d399" : "#3b82f6";
  const fmtMm = (mm: number) => mm >= 0 ? `+${Math.round(mm)}` : `${Math.round(mm)}`;

  const suspTitle = (
    <span className="flex items-center gap-1 group relative">
      Suspension
      <Info className="w-3 h-3 text-app-text-dim cursor-help inline" />
      <span className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-[10px] text-app-text-secondary whitespace-nowrap z-10 pointer-events-none normal-case tracking-normal">
        Load Distribution: 50% = balanced<br />0% Lon = all front, 0% Lat = all left
      </span>
    </span>
  );

  return (
    <WheelTable title={suspTitle} borderTop rows={[
      { label: "Travel", fl: mmValues ? C(fmtMm(mmValues[0]) + "mm", mmColor(mmValues[0])) : C(`${(suspValues[0] * 100).toFixed(0)}%`, suspColor(suspValues[0])), fr: mmValues ? C(fmtMm(mmValues[1]) + "mm", mmColor(mmValues[1])) : C(`${(suspValues[1] * 100).toFixed(0)}%`, suspColor(suspValues[1])), rl: mmValues ? C(fmtMm(mmValues[2]) + "mm", mmColor(mmValues[2])) : C(`${(suspValues[2] * 100).toFixed(0)}%`, suspColor(suspValues[2])), rr: mmValues ? C(fmtMm(mmValues[3]) + "mm", mmColor(mmValues[3])) : C(`${(suspValues[3] * 100).toFixed(0)}%`, suspColor(suspValues[3])) },
      { label: "Load", fl: `Lon ${lonLoad}%`, rl: `Lat ${latLoad}%`, fr: "", rr: "", span2: true },
    ]} />
  );
}
