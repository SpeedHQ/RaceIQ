import { createContext, useContext, type ReactNode, type ComponentProps } from "react";
import type { ReplayHost } from "../contracts/host";
import type { GameId } from "@raceiq/shared/games/ids";

const HostContext = createContext<ReplayHost | null>(null);
export function ReplayProvider({ host, children }: { host: ReplayHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}
export function useReplayHost(): ReplayHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("ReplayProvider is required");
  return host;
}
export function useMessages() { return useReplayHost().m; }
export function useSettings() { return useReplayHost().useSettings(); }
export function useUnits(gameId?: GameId) { return useReplayHost().useUnits(gameId); }
export function useTirePressureOptimal(gameId: GameId, carId: string | undefined, enabled: boolean) { return useReplayHost().useTirePressureOptimal(gameId, carId, enabled); }
export function useLocalStorage<T>(key: string, fallback: T) { return useReplayHost().useLocalStorage(key, fallback); }
export function useLapSemanticTelemetry(id: number | null) { return useReplayHost().useLapSemanticTelemetry(id); }
export function useCompareLineSpread(gameId: GameId, lapIds: readonly number[]) { return useReplayHost().useCompareLineSpread(gameId, lapIds); }
export function useTrackBoundaries(id: string | undefined, gameId?: GameId) { return useReplayHost().useTrackBoundaries(id, gameId); }

export function Button(props: ComponentProps<ReplayHost["Button"]>) { const Component = useReplayHost().Button; return <Component {...props} />; }
export function Tabs(props: ComponentProps<ReplayHost["Tabs"]>) { const Component = useReplayHost().Tabs; return <Component {...props} />; }
export function TabsList(props: ComponentProps<ReplayHost["TabsList"]>) { const Component = useReplayHost().TabsList; return <Component {...props} />; }
export function TabsTrigger(props: ComponentProps<ReplayHost["TabsTrigger"]>) { const Component = useReplayHost().TabsTrigger; return <Component {...props} />; }
export function TabsContent(props: ComponentProps<ReplayHost["TabsContent"]>) { const Component = useReplayHost().TabsContent; return <Component {...props} />; }
export function Tooltip(props: ComponentProps<ReplayHost["Tooltip"]>) { const Component = useReplayHost().Tooltip; return <Component {...props} />; }
export function TooltipTrigger(props: ComponentProps<ReplayHost["TooltipTrigger"]>) { const Component = useReplayHost().TooltipTrigger; return <Component {...props} />; }
export function TooltipProvider(props: ComponentProps<ReplayHost["TooltipProvider"]>) { const Component = useReplayHost().TooltipProvider; return <Component {...props} />; }
export function TooltipContent(props: ComponentProps<ReplayHost["TooltipContent"]>) { const Component = useReplayHost().TooltipContent; return <Component {...props} />; }
export function LoadingIndicator(props: ComponentProps<ReplayHost["LoadingIndicator"]>) { const Component = useReplayHost().LoadingIndicator; return <Component {...props} />; }
export function TireDiagram(props: ComponentProps<ReplayHost["TireDiagram"]>) { const Component = useReplayHost().TireDiagram; return <Component {...props} />; }
export function AnalyseDataContent(props: ComponentProps<ReplayHost["DataContent"]>) { const Component = useReplayHost().DataContent; return <Component {...props} />; }
export function CompareAiPanel(props: ComponentProps<ReplayHost["CompareAiPanel"]>) { const Component = useReplayHost().CompareAiPanel; return <Component {...props} />; }
