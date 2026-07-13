import type { Meta, StoryObj } from "@storybook/react";
import type { ComboOption } from "../components/tune/browser/ComboBox";
import { SetupBrowser } from "../components/tune/browser/SetupBrowser";
import type { SourceTab, TuneRow } from "../components/tune/browser/types";

// Fixed, deterministic rows — a mix of community and user tunes across two
// cars and two tracks, with and without lap times, so the snapshot covers
// tabs, filters, lap-time sorting, owner actions, and pagination header.
const rows: TuneRow[] = [
  {
    key: "community-1",
    id: "community-1",
    dbId: null,
    name: "Spa Qualifying",
    author: "SpeedHQ",
    source: "community",
    category: "circuit",
    carOrdinal: 2860,
    trackOrdinal: 7,
    lapTimeSec: 137.421,
    lapTimeRaw: "2:17.421",
    lapTimeTrack: "Spa-Francorchamps",
    description: "Low-drag qualifying setup for Spa.",
    settings: { note: "story settings" },
  },
  {
    key: "community-2",
    id: "community-2",
    dbId: null,
    name: "Nordschleife Endurance",
    author: "Community",
    source: "community",
    category: "circuit",
    carOrdinal: 2860,
    trackOrdinal: 12,
    lapTimeSec: 412.887,
    lapTimeRaw: "6:52.887",
    lapTimeTrack: "Nürburgring",
    description: "Stable long-run setup.",
    settings: { note: "story settings" },
  },
  {
    key: "user-1",
    id: "user-1",
    dbId: 1,
    name: "My Spa Race Tune",
    author: "You",
    source: "user",
    category: "circuit",
    carOrdinal: 1742,
    trackOrdinal: 7,
    lapTimeSec: null,
    lapTimeRaw: null,
    lapTimeTrack: null,
    description: "Personal race setup, work in progress.",
    settings: { note: "story settings" },
  },
  {
    key: "user-2",
    id: "user-2",
    dbId: 2,
    name: "Wet Weather Safe",
    author: "You",
    source: "user",
    category: "wet",
    carOrdinal: 1742,
    trackOrdinal: null,
    lapTimeSec: null,
    lapTimeRaw: null,
    lapTimeTrack: null,
    description: "Soft springs, high downforce.",
    settings: { note: "story settings" },
  },
];

const carNames: Record<number, string> = {
  2860: "Aston Martin Vantage GT3",
  1742: "Chevrolet Corvette C8.R",
};

const trackNames: Record<number, string> = {
  7: "Spa-Francorchamps",
  12: "Nürburgring",
};

const trackOptions: ComboOption[] = [
  { value: "any", label: "Any track", count: rows.length },
  { value: "7", label: "Spa-Francorchamps", count: 2 },
  { value: "12", label: "Nürburgring", count: 1 },
];

const carOptions: ComboOption[] = [
  { value: "any", label: "Any car", count: rows.length },
  { value: "2860", label: "Aston Martin Vantage GT3", count: 2 },
  { value: "1742", label: "Chevrolet Corvette C8.R", count: 2 },
];

const sources: SourceTab[] = [
  { key: "all", label: "All" },
  { key: "community", label: "Community" },
  { key: "user", label: "Yours" },
];

const meta: Meta<typeof SetupBrowser> = {
  title: "Setups/SetupBrowser",
  component: SetupBrowser,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh", overflow: "auto", background: "var(--app-bg)" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SetupBrowser>;

export const Default: Story = {
  args: {
    rows,
    carNames,
    trackNames,
    trackOptions,
    carOptions,
    sources,
    renderSettings: (row) => <div className="text-xs text-app-text-secondary p-2">Settings for {row.name}</div>,
    onClone: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onDuplicate: () => {},
    onNewTune: () => {},
  },
};

export const ReadOnly: Story = {
  args: {
    ...Default.args,
    readOnly: true,
  },
};
