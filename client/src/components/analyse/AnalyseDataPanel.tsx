import { getGame } from "@shared/games/registry";
import { getFuelDisplaySemantic, WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import type { FindingNarrative, FindingRecord } from "@shared/racing/findings/types";
import type { GameId } from "../../../../shared/games/ids";
import { Check, Copy } from "lucide-react";
import { getSteeringLock } from "@/lib/settings-storage";
import { useCallback, useState } from "react";
import type { useUnits } from "../../hooks/useUnits";
import type { SemanticAnalysisFrame } from "./track-map/types";
import { m } from "../../paraglide/messages";
import { FindingPanel } from "../FindingPanel";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AnalyseDynamicsPanel } from "./AnalyseDynamicsPanel";
import { AnalyseF1ErsPanel } from "./AnalyseF1ErsPanel";
import { MetricsPanel } from "./AnalyseMetricsPanel";
import { AnalyseSuspensionPanel } from "./AnalyseSuspensionPanel";
import { AnalyseTireWheelsPanel } from "./AnalyseTireWheelsPanel";

interface WearRate { FL: number; FR: number; RL: number; RR: number; }
interface Props {
  sidebarTab: "live" | "insights";
  onSidebarTabChange: (tab: "live" | "insights") => void;
  currentFrame: SemanticAnalysisFrame | null;
  startFuel: number | undefined;
  gameId: GameId;
  units: ReturnType<typeof useUnits>;
  wearRate: WearRate | null;
  findings: FindingRecord[];
  narratives?: FindingNarrative[];
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

export function buildAnalyseClipboardText({ frame, gameId, units }: { frame: SemanticAnalysisFrame; gameId: GameId; units: ReturnType<typeof useUnits> }): string {
  const game = getGame(gameId);
  const display = (value: number | null, digits = 0) => value == null ? "Unavailable" : value.toFixed(digits);
  const value = (id: string) => number(frame, id);
  const fuel = value("fuel.fuel");
  const capacity = value("fuel.fuel-capacity") ?? undefined;
  const fuelDisplay = fuel == null ? null : getFuelDisplaySemantic(fuel, capacity, game.telemetry.fuel);
  const accel = value("inputs.accel");
  const brake = value("inputs.brake");
  const steer = value("inputs.steer");
  const lock = getSteeringLock();
  const temp = wheels(frame, "tire.temperature.average");
  const wear = wheels(frame, "tires.tire-wear");
  const normalized = wheels(frame, "suspension.norm-suspension-travel");
  const millimeters = wheels(frame, "suspension.suspension-travel-m").map((entry) => entry == null ? null : entry * 1000);
  const useMm = game.telemetry.analysis?.suspensionTravel?.source !== "unavailable" && game.telemetry.analysis?.suspensionTravel?.display === "millimeters";
  const lines = [
    `Speed: ${value("motion.speed") == null ? "Unavailable" : `${units.speed(value("motion.speed")!).toFixed(0)} ${units.speedLabel}`}`,
    `RPM: ${display(value("engine.current-engine-rpm"))}`,
    `Gear: ${display(value("inputs.gear"))}`,
    `Throttle: ${accel == null ? "Unavailable" : `${((accel / 255) * 100).toFixed(0)}%`}`,
    `Brake: ${brake == null ? "Unavailable" : `${((brake / 255) * 100).toFixed(0)}%`}`,
    `Steer: ${steer == null ? "Unavailable" : `${steer > 0 ? "+" : ""}${((steer / 127) * (lock / 2)).toFixed(0)}°`}`,
  ];
  if (game.telemetry.boost) lines.push(`Boost: ${display(value("engine.boost"), 1)} psi`);
  if (game.telemetry.power) lines.push(`Power: ${value("engine.power") == null ? "Unavailable" : `${(value("engine.power")! / WATTS_PER_HORSEPOWER).toFixed(0)} hp`}`);
  if (game.telemetry.torque) lines.push(`Torque: ${display(value("engine.torque"))} Nm`);
  lines.push(`Fuel: ${fuelDisplay == null ? "Unavailable" : `${fuelDisplay.amount.toFixed(1)}${fuelDisplay.unit}`}`);
  lines.push("", "--- Dynamics ---", `G-Force Lat: ${display(value("motion.acceleration-x") == null ? null : -value("motion.acceleration-x")! / 9.81, 2)}g`, `G-Force Lon: ${display(value("motion.acceleration-z") == null ? null : -value("motion.acceleration-z")! / 9.81, 2)}g`);
  const pitTemp = game.telemetry.analysis?.tireTemperature?.source === "direct" && game.telemetry.analysis?.tireTemperature.freshness === "pit-snapshot";
  const pitHealth = game.telemetry.analysis?.tireHealth?.source === "direct" && game.telemetry.analysis?.tireHealth.freshness === "pit-snapshot";
  lines.push("", `--- ${pitTemp ? "Last Pit Tire Temps" : "Tire Temps"} ---`, `FL: ${temp[0] == null ? "Unavailable" : temp[0].toFixed(0)}  FR: ${temp[1] == null ? "Unavailable" : temp[1].toFixed(0)}`, `RL: ${temp[2] == null ? "Unavailable" : temp[2].toFixed(0)}  RR: ${temp[3] == null ? "Unavailable" : temp[3].toFixed(0)}`);
  lines.push("", `--- ${pitHealth ? "Last Pit Tire Health" : "Tire Health"} ---`, `FL: ${wear[0] == null ? "Unavailable" : `${((1 - wear[0]) * 100).toFixed(1)}%`}  FR: ${wear[1] == null ? "Unavailable" : `${((1 - wear[1]) * 100).toFixed(1)}%`}`, `RL: ${wear[2] == null ? "Unavailable" : `${((1 - wear[2]) * 100).toFixed(1)}%`}  RR: ${wear[3] == null ? "Unavailable" : `${((1 - wear[3]) * 100).toFixed(1)}%`}`);
  const suspensionValue = (index: number) => useMm
    ? (millimeters[index] == null ? "Unavailable" : `${millimeters[index]!.toFixed(0)}mm`)
    : (normalized[index] == null ? "Unavailable" : `${(normalized[index]! * 100).toFixed(0)}%`);
  lines.push(
    "",
    "--- Suspension Travel ---",
    `FL: ${suspensionValue(0)}  FR: ${suspensionValue(1)}`,
    `RL: ${suspensionValue(2)}  RR: ${suspensionValue(3)}`,
  );
  return lines.join("\n");
}
export function AnalyseDataPanel({ sidebarTab, onSidebarTabChange, currentFrame, startFuel, gameId, units, wearRate, findings, narratives = [], onJumpToFrame }: Props) {
  const [copied, setCopied] = useState(false);
  const handleCopyValues = useCallback(() => {
    if (!currentFrame) return;
    navigator.clipboard.writeText(buildAnalyseClipboardText({ frame: currentFrame, gameId, units }));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [currentFrame, gameId, units]);
  return <Tabs value={sidebarTab} onValueChange={(value) => { if (value === "live" || value === "insights") onSidebarTabChange(value); }} className="flex h-[34rem] w-full shrink-0 flex-col overflow-hidden border-t border-app-border bg-app-surface/50 @5xl/workspace:h-full @5xl/workspace:w-[clamp(18rem,30cqw,22rem)] @5xl/workspace:border-t-0 @5xl/workspace:border-l">
    <TabsList variant="underline" className="w-full shrink-0"><TabsTrigger value="live" className="flex-1">{m.analyse_tab_data()}</TabsTrigger><TabsTrigger value="insights" className="flex-1">Findings{findings.length > 0 && <span className="ml-1 rounded-full bg-app-border-input px-1.5 text-app-micro text-app-text">{findings.length}</span>}</TabsTrigger></TabsList>
    <TabsContent value="live" className="flex min-h-0 flex-1 flex-col"><div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-1"><h3 className="mb-0 text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.analyse_metrics_at_cursor()}</h3>{currentFrame && <Button type="button" onClick={handleCopyValues} title={m.analyse_copy_values_tooltip()} className="text-app-text-muted transition-colors hover:text-app-text">{copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}</Button>}</div><div className="min-h-0 flex-1 overflow-y-auto p-3">{currentFrame && <MetricsPanel frame={currentFrame} startFuel={startFuel} gameId={gameId} />}{currentFrame && <><div className="mt-3 mb-2 border-t border-app-border pt-2"><h3 className="text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.analyse_section_dynamics()}</h3></div><AnalyseDynamicsPanel frame={currentFrame} gameId={gameId} units={units} /><AnalyseTireWheelsPanel frame={currentFrame} gameId={gameId} units={units} wearRate={wearRate} /><AnalyseSuspensionPanel frame={currentFrame} gameId={gameId} />{getGame(gameId).telemetry.ers && <AnalyseF1ErsPanel frame={currentFrame} />}</>}</div></TabsContent>
    <TabsContent value="insights" className="min-h-0 flex-1 overflow-y-auto p-3"><FindingPanel findings={findings} narratives={narratives} onJumpToFrame={onJumpToFrame} /></TabsContent>
  </Tabs>;
}
