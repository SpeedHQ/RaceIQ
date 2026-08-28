import { EventClient } from "@tanstack/devtools-event-client";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect, useState, type ComponentProps } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { DevStateContent } from "../components/DevStateViewer";
import { TanStackStoreDevtoolsPanel, type StoreDescriptor } from "./TanStackStoreDevtoolsPanel";
import { devTelemetryStore, type DevTelemetryState } from "../stores/dev-telemetry";
import { gameStore, type GameState } from "../stores/game";
import { telemetryStore, type TelemetryState } from "../stores/telemetry";
import { uiStore, type UiState } from "../stores/ui";

export type RaceIqRuntimeSnapshot = {
  capturedAtMs: number;
  server: unknown | null;
  stores: {
    telemetry: TelemetryState;
    game: GameState;
    ui: UiState;
    devTelemetry: DevTelemetryState;
  };
};

export type RaceIqDevtoolsEvents = {
  "runtime-snapshot": RaceIqRuntimeSnapshot;
  "request-runtime-snapshot": void;
  "toggle-server-state-pause": void;
};

export const raceIqRuntimeEventClient = new EventClient<RaceIqDevtoolsEvents>({ pluginId: "raceiq-runtime" });

type Router = ComponentProps<typeof TanStackRouterDevtoolsPanel>["router"];

function snapshot(): RaceIqRuntimeSnapshot {
  const telemetry = telemetryStore.get();
  return {
    capturedAtMs: Date.now(),
    server: telemetry.devState,
    stores: { telemetry, game: gameStore.get(), ui: uiStore.get(), devTelemetry: devTelemetryStore.get() },
  };
}

function RaceIqRuntimeBridge() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => raceIqRuntimeEventClient.emit("runtime-snapshot", snapshot());
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; publish(); }, 250);
    };
    const subscriptions = [telemetryStore, gameStore, uiStore, devTelemetryStore].map((store) => store.subscribe(schedule));
    publish();
    const removeRequest = raceIqRuntimeEventClient.on("request-runtime-snapshot", publish);
    const removeToggle = raceIqRuntimeEventClient.on("toggle-server-state-pause", () => telemetryStore.actions.toggleDevStatePause());
    return () => {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      if (timer) clearTimeout(timer);
      removeRequest();
      removeToggle();
    };
  }, []);
  return null;
}

function RaceIqRuntimePanel() {
  const [runtime, setRuntime] = useState<RaceIqRuntimeSnapshot | null>(null);
  useEffect(() => {
    const remove = raceIqRuntimeEventClient.on("runtime-snapshot", (event) => setRuntime(event.payload));
    raceIqRuntimeEventClient.emit("request-runtime-snapshot", undefined);
    return remove;
  }, []);
  if (!runtime) return <div className="p-4">Waiting...</div>;
  return <DevStateContent server={runtime.server} stores={runtime.stores} paused={runtime.stores.telemetry.devStatePaused} onTogglePause={() => raceIqRuntimeEventClient.emit("toggle-server-state-pause", undefined)} />;
}

const tanStackStoreDescriptors = {
  telemetry: { name: "Telemetry", store: telemetryStore },
  game: { name: "Game", store: gameStore },
  ui: { name: "UI", store: uiStore },
  devTelemetry: { name: "Dev Telemetry", store: devTelemetryStore },
} satisfies Record<"telemetry" | "game" | "ui" | "devTelemetry", StoreDescriptor<unknown>>;

export default function RaceIqDevtools({ router, queryClient }: { router: Router; queryClient: QueryClient }) {
  return (
    <>
      <RaceIqRuntimeBridge />
      <TanStackDevtools plugins={[
        { id: "tanstack-query", name: "TanStack Query", render: <ReactQueryDevtoolsPanel client={queryClient} /> },
        { id: "tanstack-router", name: "TanStack Router", render: <TanStackRouterDevtoolsPanel router={router} /> },
        {
          id: "tanstack-store",
          name: "TanStack Store",
          render: <TanStackStoreDevtoolsPanel {...tanStackStoreDescriptors} />,
        },
        { id: "raceiq-runtime", name: "RaceIQ Runtime", render: <RaceIqRuntimePanel /> },
      ]} />
    </>
  );
}
