import { getGame } from "@shared/games/registry";
import { getFuelDisplaySemantic, WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import type { LapInsight } from "@shared/racing/analysis/laps/insights/types";
import { suspensionCompressionBias } from "../../../../shared/racing/analysis/laps/physics/vehicle";
import type { GameId } from "../../../../shared/games/ids";
import { Check, Copy } from "lucide-react";
import { getSteeringLock } from "@/lib/settings-storage";
import { useCallback, useState } from "react";
import type { useUnits } from "../../hooks/useUnits";
import type { SemanticAnalysisFrame } from "./track-map/types";
import { convertTemp } from "../../lib/temperature";
import { m } from "../../paraglide/messages";
import { InsightPanel } from "../InsightPanel";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AnalyseDynamicsPanel } from "./AnalyseDynamicsPanel";
import type { LapCapabilities } from "./analyse-capabilities";
import { AnalyseF1ErsPanel } from "./AnalyseF1ErsPanel";
import { MetricsPanel } from "./AnalyseMetricsPanel";
import { AnalyseSuspensionPanel } from "./AnalyseSuspensionPanel";
import { AnalyseTireWheelsPanel } from "./AnalyseTireWheelsPanel";

interface WearRate { FL: number; FR: number; RL: number; RR: number; }
interface Props {
  sidebarTab: "live" | "insights";
  onSidebarTabChange: (tab: "live" | "insights") => void;
  currentFrame: SemanticAnalysisFrame | null;
  lapCapabilities: LapCapabilities;
  startFuel: number | undefined;
  gameId: GameId;
  units: ReturnType<typeof useUnits>;
  wearRate: WearRate | null;
  lapInsights: LapInsight[];
  onJumpToFrame: (idx: number) => void;
}
const number = (frame: SemanticAnalysisFrame, id: string): number | null => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const wheels = (frame: SemanticAnalysisFrame, id: string): (number | null)[] => {
  const value = frame.values[id];
  return Array.isArray(value) ? value.slice(0, 4).map((entry) => typeof entry === "number" && Number.isFinite(entry) ? entry : null) : [null, null, null, null];
};

export function AnalyseDataPanel({ sidebarTab, onSidebarTabChange, currentFrame, lapCapabilities, startFuel, gameId, units, wearRate, lapInsights, onJumpToFrame }: Props) {
  const [copied, setCopied] = useState(false);
  const handleCopyValues = useCallback(() => {
    if (!currentFrame) return;
    const game = getGame(gameId);
    const display = (value: number | null, digits = 0) => value == null ? "Unavailable" : value.toFixed(digits);
    const speed = number(currentFrame, "motion.speed");
    const fuel = number(currentFrame, "fuel.fuel");
    const capacity = number(currentFrame, "fuel.fuel-capacity") ?? undefined;
    const fuelDisplay = fuel == null ? null : getFuelDisplaySemantic(fuel, capacity, game.telemetry.fuel);
    const fuelUsed = startFuel != null && fuel != null ? getFuelDisplaySemantic(Math.max(0, startFuel - fuel), capacity, game.telemetry.fuel) : null;
    const accel = number(currentFrame, "inputs.accel");
    const brake = number(currentFrame, "inputs.brake");
    const steer = number(currentFrame, "inputs.steer");
    const lock = getSteeringLock();
    const temp = wheels(currentFrame, "tire.temperature.average");
    const wear = wheels(currentFrame, "tires.tire-wear");
    const normalized = wheels(currentFrame, "suspension.norm-suspension-travel");
    const millimeters = wheels(currentFrame, "suspension.suspension-travel-m").map((value) => value == null ? null : value * 1000);
    const useMm = game.telemetry.analysis?.suspensionTravel?.display === "millimeters";
    const lines = [
      `Speed: ${speed == null ? "Unavailable" : `${units.speed(speed).toFixed(0)} ${units.speedLabel}`}`,
      `RPM: ${display(number(currentFrame, "engine.current-engine-rpm"))}`,
      `Gear: ${display(number(currentFrame, "inputs.gear"))}`,
      `Throttle: ${accel == null ? "Unavailable" : `${((accel / 255) * 100).toFixed(0)}%`}`,
      `Brake: ${brake == null ? "Unavailable" : `${((brake / 255) * 100).toFixed(0)}%`}`,
      `Steer: ${steer == null ? "Unavailable" : `${steer > 0 ? "+" : ""}${((steer / 127) * (lock / 2)).toFixed(0)}°`}`,
    ];
    if (game.telemetry.boost && number(currentFrame, "engine.boost") != null) lines.push(`Boost: ${number(currentFrame, "engine.boost")!.toFixed(1)} psi`);
    if (game.telemetry.power && number(currentFrame, "engine.power") != null) lines.push(`Power: ${(number(currentFrame, "engine.power")! / WATTS_PER_HORSEPOWER).toFixed(0)} hp`);
    if (game.telemetry.torque && number(currentFrame, "engine.torque") != null) lines.push(`Torque: ${number(currentFrame, "engine.torque")!.toFixed(0)} Nm`);
    lines.push(`Fuel: ${fuelDisplay == null ? "Unavailable" : `${fuelDisplay.amount.toFixed(1)}${fuelDisplay.unit}`} left${fuelUsed == null ? "" : ` (${fuelUsed.amount.toFixed(1)}${fuelUsed.unit} used)`}`);
    lines.push("", "--- Dynamics ---", `G-Force Lat: ${display(number(currentFrame, "motion.acceleration-x") == null ? null : -number(currentFrame, "motion.acceleration-x")! / 9.81, 2)}g`, `G-Force Lon: ${display(number(currentFrame, "motion.acceleration-z") == null ? null : -number(currentFrame, "motion.acceleration-z")! / 9.81, 2)}g`);
    const pitTemp = game.telemetry.analysis?.tireTemperature?.freshness === "pit-snapshot";
    const pitHealth = game.telemetry.analysis?.tireHealth?.freshness === "pit-snapshot";
    lines.push("", `--- ${pitTemp ? "Last Pit Tire Temps" : "Tire Temps"} ---`, `FL: ${temp[0] == null ? "Unavailable" : `${convertTemp(temp[0], units.temperatureUnit, "C").toFixed(0)}${units.tempLabel}`}  FR: ${temp[1] == null ? "Unavailable" : `${convertTemp(temp[1], units.temperatureUnit, "C").toFixed(0)}${units.tempLabel}`}`, `RL: ${temp[2] == null ? "Unavailable" : `${convertTemp(temp[2], units.temperatureUnit, "C").toFixed(0)}${units.tempLabel}`}  RR: ${temp[3] == null ? "Unavailable" : `${convertTemp(temp[3], units.temperatureUnit, "C").toFixed(0)}${units.tempLabel}`}`);
    lines.push("", `--- ${pitHealth ? "Last Pit Tire Health" : "Tire Health"} ---`, `FL: ${wear[0] == null ? "Unavailable" : `${((1 - wear[0]) * 100).toFixed(1)}%`}  FR: ${wear[1] == null ? "Unavailable" : `${((1 - wear[1]) * 100).toFixed(1)}%`}`, `RL: ${wear[2] == null ? "Unavailable" : `${((1 - wear[2]) * 100).toFixed(1)}%`}  RR: ${wear[3] == null ? "Unavailable" : `${((1 - wear[3]) * 100).toFixed(1)}%`}`);
    lines.push("", "--- Suspension Travel ---", ...[0, 1, 2, 3].map((i) => `${["FL", "FR", "RL", "RR"][i]}: ${useMm ? (millimeters[i] == null ? "Unavailable" : `${millimeters[i]!.toFixed(0)}mm`) : (normalized[i] == null ? "Unavailable" : `${(normalized[i]! * 100).toFixed(0)}%`)}`));
    if (normalized.every((value): value is number => value != null)) {
      const bias = suspensionCompressionBias([normalized[0], normalized[1], normalized[2], normalized[3]]);
      lines.push(`Compression bias: Front ${(bias.front * 100).toFixed(0)}%  Left ${(bias.left * 100).toFixed(0)}%`);
    }
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [currentFrame, gameId, startFuel, units]);
  return <Tabs value={sidebarTab} onValueChange={(value) => { if (value === "live" || value === "insights") onSidebarTabChange(value); }} className="flex h-[34rem] w-full shrink-0 flex-col overflow-hidden border-t border-app-border bg-app-surface/50 @5xl/workspace:h-full @5xl/workspace:w-[clamp(18rem,30cqw,22rem)] @5xl/workspace:border-t-0 @5xl/workspace:border-l">
    <TabsList variant="underline" className="w-full shrink-0"><TabsTrigger value="live" className="flex-1">{m.analyse_tab_data()}</TabsTrigger><TabsTrigger value="insights" className="flex-1">{m.analyse_tab_insights()}{lapInsights.length > 0 && <span className="ml-1 rounded-full bg-app-border-input px-1.5 text-app-micro text-app-text">{lapInsights.length}</span>}</TabsTrigger></TabsList>
    <TabsContent value="live" className="flex min-h-0 flex-1 flex-col"><div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-1"><h3 className="mb-0 text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.analyse_metrics_at_cursor()}</h3>{currentFrame && <Button type="button" onClick={handleCopyValues} title={m.analyse_copy_values_tooltip()} className="text-app-text-muted transition-colors hover:text-app-text">{copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}</Button>}</div><div className="min-h-0 flex-1 overflow-y-auto p-3">{currentFrame && <MetricsPanel frame={currentFrame} startFuel={startFuel} gameId={gameId} />}{currentFrame && <><div className="mt-3 mb-2 border-t border-app-border pt-2"><h3 className="text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.analyse_section_dynamics()}</h3></div><AnalyseDynamicsPanel frame={currentFrame} gameId={gameId} units={units} /><AnalyseTireWheelsPanel frame={currentFrame} gameId={gameId} units={units} wearRate={wearRate} /><AnalyseSuspensionPanel frame={currentFrame} gameId={gameId} /><AnalyseF1ErsPanel frame={currentFrame} capabilities={lapCapabilities} /></>}</div></TabsContent>
    <TabsContent value="insights" className="min-h-0 flex-1 overflow-y-auto p-3"><InsightPanel insights={lapInsights} onJumpToFrame={onJumpToFrame} /></TabsContent>
  </Tabs>;
}
