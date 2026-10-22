import type { ReactNode } from "react";
import { ReplayProvider } from "@raceiq/lap-replay/ui";
import type { ReplayHost, ReplayDataProps } from "@raceiq/lap-replay/contracts";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadingIndicator } from "@/components/LoadingIndicator";
import { TireDiagram } from "@/components/telemetry/TireDiagram";
import { AnalyseDataContent } from "@/components/analyse/AnalyseDataPanel";
import { CompareAiPanel } from "@/components/comparison/CompareAiPanel";
import { useSettings } from "@/hooks/settings";
import { useUnits } from "@/hooks/useUnits";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useLapSemanticTelemetry, useCompareLineSpread } from "@/hooks/laps";
import { useTrackBoundaries } from "@/hooks/track-queries";
import { useTirePressureOptimal } from "@/hooks/catalog-queries";
import { loadCarModelConfigs } from "@/data/car-models";
import { resolveCarModelSelection } from "@/components/wireframe/resolve-car-model";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { formatLapTime } from "@/lib/format";
import { getLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";

function ReplayDataContent(props: ReplayDataProps) {
  const units = useUnits(props.gameId);
  return <AnalyseDataContent {...props} units={units} />;
}
const host: ReplayHost = {
  m, Button, Tabs, TabsContent, TabsList, TabsTrigger,
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
  LoadingIndicator, TireDiagram, DataContent: ReplayDataContent, CompareAiPanel,
  useSettings, useUnits, useLocalStorage, useLapSemanticTelemetry, useCompareLineSpread, useTrackBoundaries, useTirePressureOptimal,
  getLocale, formatLapTime, syncCanvasSize,
  models: { loadCarModelConfigs, resolveCarModelSelection },
};
export function LapReplayHostProvider({ children }: { children: ReactNode }) {
  return <ReplayProvider host={host}>{children}</ReplayProvider>;
}
