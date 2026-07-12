import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { ComboDash } from "../../components/dashes/ComboDash";
import {
  fakeForzaPacket,
  fakeForzaDisplayPacket,
  fakeF1Packet,
  fakeF1DisplayPacket,
  fakeAccPacket,
  fakeAccDisplayPacket,
  fakeAcEvoPacket,
  fakeAcEvoDisplayPacket,
  fakeSectors,
  fakePit,
} from "../fakeData";
import type { TelemetryPacket, GameId } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import { useGameStore } from "../../stores/game";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const fToC = (f: number) => ((f - 32) * 5) / 9;
const idC = (c: number) => c;

type Game = "fm-2023" | "f1-2025" | "acc" | "ac-evo";

// Brake / pressure values only populated for games whose adapters provide them.
const BRAKE_PRESSURE = {
  BrakeTempFrontLeft: 380,
  BrakeTempFrontRight: 375,
  BrakeTempRearLeft: 240,
  BrakeTempRearRight: 238,
  TirePressureFrontLeft: 27.8,
  TirePressureFrontRight: 27.7,
  TirePressureRearLeft: 26.5,
  TirePressureRearRight: 26.4,
} as const;

interface GameFixture {
  raw: TelemetryPacket;
  display: DisplayPacket;
  tempUnit: "C" | "F";
}

const FIXTURES: Record<Game, GameFixture> = {
  "fm-2023": {
    raw: {
      ...fakeForzaPacket,
      f1: { ...(fakeForzaPacket.f1 ?? {}), totalLaps: 57 },
    } as TelemetryPacket,
    display: fakeForzaDisplayPacket,
    tempUnit: "F",
  },
  "f1-2025": {
    raw: { ...fakeF1Packet, ...BRAKE_PRESSURE } as TelemetryPacket,
    display: fakeF1DisplayPacket,
    tempUnit: "C",
  },
  acc: {
    raw: { ...fakeAccPacket, ...BRAKE_PRESSURE } as TelemetryPacket,
    display: fakeAccDisplayPacket,
    tempUnit: "C",
  },
  "ac-evo": {
    raw: { ...fakeAcEvoPacket, ...BRAKE_PRESSURE } as TelemetryPacket,
    display: fakeAcEvoDisplayPacket,
    tempUnit: "C",
  },
};

interface Args {
  game: Game;
  rpm: number;
  gear: number;
  unitSystem: "metric" | "imperial";
}

function GameIdSync({ game }: { game: Game }) {
  const setGameId = useGameStore((s) => s.setGameId);
  useEffect(() => {
    setGameId(game as GameId);
    return () => setGameId(null);
  }, [game, setGameId]);
  return null;
}

function render({ game, rpm, gear, unitSystem }: Args) {
  const fx = FIXTURES[game];
  const raw = { ...fx.raw, CurrentEngineRpm: rpm, Gear: gear } as TelemetryPacket;
  const display = {
    ...fx.display,
    CurrentEngineRpm: rpm,
    Gear: gear,
  } as DisplayPacket;
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
        <ComboDash rawPacket={raw} packet={display} sectors={fakeSectors} pit={fakePit} unitSystem={unitSystem} toTempC={fx.tempUnit === "F" ? fToC : idC} />
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
      description: "Which game the fake packet represents (sets gameId store)",
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
      <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
        <ComboDash rawPacket={null} packet={null} sectors={null} pit={null} unitSystem="metric" toTempC={fToC} />
      </div>
    </QueryClientProvider>
  ),
};
