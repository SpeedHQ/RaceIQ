import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import type { GameId } from "../../../../shared/games/ids";
import { ComboDash2 } from "../../components/dashes/ComboDash2";
import { useGameStore } from "../../stores/game";
import { fakeAccSemanticFixture, fakeAcEvoSemanticFixture, fakeAllDataTelemetryView, fakeF1SemanticFixture, fakeForzaSemanticFixture, generateFakeSessionLaps } from "../fakeData";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const MAX_LAPS = 100;

type Game = "fm-2023" | "f1-2025" | "acc" | "ac-evo";
type Fixture = Game | "all-data";

const VIEWS: Record<Fixture, LiveTelemetryView> = {
  "all-data": fakeAllDataTelemetryView,
  "fm-2023": fakeForzaSemanticFixture.view,
  "f1-2025": fakeF1SemanticFixture.view,
  acc: fakeAccSemanticFixture.view,
  "ac-evo": fakeAcEvoSemanticFixture.view,
};

function withRouter(node: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return <RouterProvider router={router} />;
}

function GameIdSync({ game }: { game: Game }) {
  const setGameId = useGameStore((s) => s.setGameId);
  useEffect(() => {
    setGameId(game as GameId);
    return () => setGameId(null);
  }, [game, setGameId]);
  return null;
}

interface Args {
  game: Fixture;
  lapCount: number;
}

function render({ game, lapCount }: Args) {
  const laps = generateFakeSessionLaps(lapCount);
  return (
    <QueryClientProvider client={queryClient}>
      {game === "all-data" ? null : <GameIdSync game={game} />}
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "19.5 / 9",
          background: "var(--app-bg)",
          overflow: "hidden",
          transform: "translateZ(0)",
        }}
      >
        {withRouter(<ComboDash2 view={VIEWS[game]} sessionLaps={laps} />)}
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<Args> = {
  title: "Dashes/Combo/Combo Dash 2",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: true, height: "420px" } },
  },
  argTypes: {
    game: {
      name: "Game",
      control: { type: "radio" },
      options: ["fm-2023", "f1-2025", "acc", "ac-evo"] satisfies Game[],
    },
    lapCount: {
      name: "Laps",
      control: { type: "range", min: 1, max: MAX_LAPS, step: 1 },
    },
  },
  args: {
    game: "fm-2023",
    lapCount: 10,
  },
};

export default meta;
type Story = StoryObj<Args>;

export const AllData: Story = {
  name: "All Data",
  args: { game: "all-data", lapCount: 10 },
  render,
};

export const FM2023: Story = { name: "FM 2023", args: { game: "fm-2023" }, render };
export const F12025: Story = { name: "F1 2025", args: { game: "f1-2025" }, render };
export const ACC: Story = { name: "ACC", args: { game: "acc" }, render };
export const ACEvo: Story = { name: "AC Evo", args: { game: "ac-evo" }, render };

export const NoData: Story = {
  render: () => (
    <div style={{ width: "100vw", height: "100vh", background: "var(--app-bg)" }}>
      <ComboDash2 view={null} sessionLaps={[]} />
    </div>
  ),
};
