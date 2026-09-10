import { useGameStore } from "../stores/game";
import { telemetryStore, useTelemetryStore } from "../stores/telemetry";
import { useUiStore } from "../stores/ui";
import { Button } from "./ui/button";

export type DevStateContentProps = {
  server: unknown | null;
  stores: { telemetry: unknown; game: unknown; ui: unknown; devTelemetry?: unknown };
  paused: boolean;
  onTogglePause: () => void;
};

export function DevStateContent({ server, stores, paused, onTogglePause }: DevStateContentProps) {
  return (
    <div className="flex flex-col h-full overflow-hidden p-2 gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-app-text-muted uppercase tracking-wider">Dev State</span>
        <Button variant="app-outline" size="app-sm" onClick={onTogglePause}>{paused ? "Resume" : "Pause"}</Button>
      </div>
      <div className="flex gap-2 flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="text-xs text-app-text-muted mb-1">Server</div>
          <pre className="flex-1 overflow-auto text-xs font-mono bg-app-surface border border-app-border rounded p-2 text-app-text">{server ? JSON.stringify(server, null, 2) : "Waiting..."}</pre>
        </div>
        <div className="flex-1 flex flex-col min-w-0">
          <div className="text-xs text-app-text-muted mb-1">TanStack Store</div>
          <pre className="flex-1 overflow-auto text-xs font-mono bg-app-surface border border-app-border rounded p-2 text-app-text">{JSON.stringify(stores, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}

export function DevStateViewer() {
  const devState = useTelemetryStore((s) => s.devState);
  const devStatePaused = useTelemetryStore((s) => s.devStatePaused);
  const telemetry = useTelemetryStore((s) => s);
  const game = useGameStore((s) => s);
  const ui = useUiStore((s) => s);
  return <DevStateContent server={devState} stores={{ telemetry, game, ui }} paused={devStatePaused} onTogglePause={telemetryStore.actions.toggleDevStatePause} />;
}
