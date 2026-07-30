import { resolveAnalysisTelemetry } from "@shared/games/analysis-telemetry";
import { tryGetGame } from "@shared/games/registry";
import { suspensionCompression } from "@shared/lib/vehicle-physics";
import type { TelemetryPacket } from "@shared/types";
import { Info } from "lucide-react";
import { operatingRangeColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";
import { WheelTable } from "./WheelTable";

interface Props {
  currentPacket: TelemetryPacket;
}

export function AnalyseSuspensionPanel({ currentPacket }: Props) {
  const analysis = resolveAnalysisTelemetry(tryGetGame(currentPacket.gameId));
  const suspValues = [currentPacket.NormSuspensionTravelFL, currentPacket.NormSuspensionTravelFR, currentPacket.NormSuspensionTravelRL, currentPacket.NormSuspensionTravelRR];
  const suspColor = (value: number) => operatingRangeColor(value, [0.25, 0.65, 0.85]);
  const compression = suspensionCompression(currentPacket);
  const frontCompression = (compression.frontBias * 100).toFixed(0);
  const leftCompression = (compression.leftBias * 100).toFixed(0);
  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;

  const showMillimeters =
    analysis.suspensionTravel.source !== "unavailable" &&
    analysis.suspensionTravel.display === "millimeters";
  const mmValues = showMillimeters
    ? [currentPacket.SuspensionTravelMFL * 1000, currentPacket.SuspensionTravelMFR * 1000, currentPacket.SuspensionTravelMRL * 1000, currentPacket.SuspensionTravelMRR * 1000]
    : null;
  const fmtMm = (mm: number) => `${Math.round(mm)}mm`;

  const suspTitle = (
    <span className="flex items-center gap-1 group relative">
      {m.dataguide_suspension()}
      <Info className="w-3 h-3 text-app-text-dim cursor-help inline" />
      <span className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-[10px] text-app-text-secondary whitespace-nowrap z-10 pointer-events-none normal-case tracking-normal">
        {m.analyse_suspension_compression_tooltip()}
      </span>
    </span>
  );

  return (
    <WheelTable
      title={suspTitle}
      borderTop
      rows={[
        {
          label: m.dataguide_travel(),
          fl: mmValues ? C(fmtMm(mmValues[0]), "var(--app-text)") : C(`${(suspValues[0] * 100).toFixed(0)}%`, suspColor(suspValues[0])),
          fr: mmValues ? C(fmtMm(mmValues[1]), "var(--app-text)") : C(`${(suspValues[1] * 100).toFixed(0)}%`, suspColor(suspValues[1])),
          rl: mmValues ? C(fmtMm(mmValues[2]), "var(--app-text)") : C(`${(suspValues[2] * 100).toFixed(0)}%`, suspColor(suspValues[2])),
          rr: mmValues ? C(fmtMm(mmValues[3]), "var(--app-text)") : C(`${(suspValues[3] * 100).toFixed(0)}%`, suspColor(suspValues[3])),
        },
        {
          label: m.analyse_suspension_compression_bias(),
          fl: `${m.analyse_suspension_front()} ${frontCompression}%`,
          rl: `${m.analyse_suspension_left()} ${leftCompression}%`,
          fr: "",
          rr: "",
          span2: true,
        },
      ]}
    />
  );
}
