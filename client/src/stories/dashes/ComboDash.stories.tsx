import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import type { GameId } from "../../../../shared/games/ids";
import { ComboDash } from "../../components/dashes/ComboDash";
import { gameStore } from "../../stores/game";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";
import { fakeAcEvoSemanticFixture, fakeAccSemanticFixture, fakeF1SemanticFixture, fakeForzaSemanticFixture, fakePit, fakeSectors } from "../fakeData";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

type Game = "fm-2023" | "f1-2025" | "acc" | "ac-evo";

const VIEWS: Record<Game, LiveTelemetryView> = {
  "fm-2023": fakeForzaSemanticFixture.view,
  "f1-2025": fakeF1SemanticFixture.view,
  acc: fakeAccSemanticFixture.view,
  "ac-evo": fakeAcEvoSemanticFixture.view,
};

interface Args {
  game: Game;
  rpm: number;
  gear: number;
  unitSystem: "metric" | "imperial";
}

function GameIdSync({ game }: { game: Game }) {
  const setGameId = gameStore.actions.setGameId;
  useEffect(() => {
    setGameId(game as GameId);
    return () => setGameId(null);
  }, [game, setGameId]);
  return null;
}

function render({ game, rpm, gear, unitSystem }: Args) {
  const fixture = VIEWS[game];
  const view: LiveTelemetryView = {
    ...fixture,
    engine: { ...fixture.engine, rpm },
    inputs: { ...fixture.inputs, gear },
  };
  return (
    <QueryClientProvider client={queryClient}>
      <GameIdSync game={game} />
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
        <ComboDash view={view} sectors={fakeSectors} pit={fakePit} unitSystem={unitSystem} />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<Args> = {
  title: "Dashes/Combo/Combo Dash 1",
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
      description: "Which simulator semantic view to render",
    },
    rpm: {
      name: "RPM",
      control: { type: "range", min: 3000, max: 18000, step: 50 },
    },
    gear: {
      name: "Gear",
      control: { type: "range", min: 0, max: 10, step: 1 },
      description: "0 = R, 1 = N, 2+ = forward gears",
    },
    unitSystem: {
      name: "Units",
      control: { type: "radio" },
      options: ["metric", "imperial"],
    },
  },
  args: {
    game: "fm-2023",
    rpm: 14200,
    gear: 7,
    unitSystem: "metric",
  },
};

export default meta;
type Story = StoryObj<Args>;

export const FM2023: Story = {
  name: "FM 2023",
  args: { game: "fm-2023" },
  render,
};

export const F12025: Story = {
  name: "F1 2025",
  args: { game: "f1-2025" },
  render,
};

export const ACC: Story = {
  name: "ACC",
  args: { game: "acc" },
  render,
};

export const ACEvo: Story = {
  name: "AC Evo",
  args: { game: "ac-evo" },
  render,
};

export const NoData: Story = {
  render: () => (
    <QueryClientProvider client={queryClient}>
      <div style={{ width: "100vw", height: "100vh", background: "var(--app-bg)" }}>
        <ComboDash view={null} sectors={null} pit={null} unitSystem="metric" />
      </div>
    </QueryClientProvider>
  ),
};
