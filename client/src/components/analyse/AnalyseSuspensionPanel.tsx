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
      { label: "Travel", fl: C(`${(suspValues[0] * 100).toFixed(0)}%`, suspColor(suspValues[0])), fr: C(`${(suspValues[1] * 100).toFixed(0)}%`, suspColor(suspValues[1])), rl: C(`${(suspValues[2] * 100).toFixed(0)}%`, suspColor(suspValues[2])), rr: C(`${(suspValues[3] * 100).toFixed(0)}%`, suspColor(suspValues[3])) },
      { label: "Load", fl: `Lon ${lonLoad}%`, rl: `Lat ${latLoad}%`, fr: "", rr: "", span2: true },
    ]} />
  );
}
