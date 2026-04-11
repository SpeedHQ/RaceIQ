import { useTelemetryStore } from "../stores/telemetry";
import { useGameStore } from "../stores/game";
import { useUiStore } from "../stores/ui";

export function DevStateViewer() {
  const devState = useTelemetryStore((s) => s.devState);
  const devStatePaused = useTelemetryStore((s) => s.devStatePaused);
  const toggleDevStatePause = useTelemetryStore((s) => s.toggleDevStatePause);

  const zustandSnapshot = {
    telemetry: useTelemetryStore.getState(),
    game: useGameStore.getState(),
    ui: useUiStore.getState(),
  };

  return (
    <div className="flex flex-col h-full overflow-hidden p-2 gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-app-text-muted uppercase tracking-wider">Dev State</span>
        <button
          onClick={toggleDevStatePause}
          className="text-xs px-2 py-1 rounded border border-app-border text-app-text-secondary hover:text-app-text"
        >
          {devStatePaused ? "Resume" : "Pause"}
        </button>
      </div>
      <div className="flex gap-2 flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="text-xs text-app-text-muted mb-1">Server</div>
          <pre className="flex-1 overflow-auto text-xs font-mono bg-app-surface border border-app-border rounded p-2 text-app-text">
            {devState ? JSON.stringify(devState, null, 2) : "Waiting..."}
          </pre>
        </div>
        <div className="flex-1 flex flex-col min-w-0">
          <div className="text-xs text-app-text-muted mb-1">Zustand</div>
          <pre className="flex-1 overflow-auto text-xs font-mono bg-app-surface border border-app-border rounded p-2 text-app-text">
            {JSON.stringify(zustandSnapshot, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
