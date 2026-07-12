import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider, createRootRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ComboDash2 } from "../../components/dashes/ComboDash2";
import { fakeForzaPacket, fakeF1Packet, fakeAccPacket, fakeAcEvoPacket, generateFakeSessionLaps } from "../fakeData";
import type { TelemetryPacket, GameId } from "@shared/types";
import { useGameStore } from "../../stores/game";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const MAX_LAPS = 100;

type Game = "fm-2023" | "f1-2025" | "acc" | "ac-evo";

const PACKETS: Record<Game, TelemetryPacket> = {
  "fm-2023": fakeForzaPacket,
  "f1-2025": fakeF1Packet,
  acc: fakeAccPacket,
  "ac-evo": fakeAcEvoPacket,
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
  game: Game;
  lapCount: number;
}

function render({ game, lapCount }: Args) {
  const laps = generateFakeSessionLaps(lapCount);
  const rawPacket = PACKETS[game];
  return (
    <QueryClientProvider client={queryClient}>
      <GameIdSync game={game} />
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "19.5 / 9",
          background: "#000",
          overflow: "hidden",
          transform: "translateZ(0)",
        }}
      >
        {withRouter(<ComboDash2 rawPacket={rawPacket} sessionLaps={laps} />)}
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

export const FM2023: Story = { name: "FM 2023", args: { game: "fm-2023" }, render };
export const F12025: Story = { name: "F1 2025", args: { game: "f1-2025" }, render };
export const ACC: Story = { name: "ACC", args: { game: "acc" }, render };
export const ACEvo: Story = { name: "AC Evo", args: { game: "ac-evo" }, render };

export const NoData: Story = {
  render: () => (
    <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
      <ComboDash2 rawPacket={null} sessionLaps={[]} />
    </div>
  ),
};
