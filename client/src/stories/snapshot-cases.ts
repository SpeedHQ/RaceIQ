export interface StorybookSnapshotCase {
  name: string;
  id: string;
  outputName: string;
  viewport?: { width: number; height: number };
  readyText?: string;
  hoverLabel?: string;
}

// Single screenshot inventory for CI and `bun run ui:diff`.
// Rendering environments may differ, but both paths must capture these cases.
export const DASHBOARD_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [
  {
    name: "F1LiveDashboard",
    id: "dashboards-f1livedashboard--default",
    outputName: "snapshot-F1LiveDashboard.png",
  },
  {
    name: "ForzaLiveDashboard",
    id: "dashboards-forzalivedashboard--default",
    outputName: "snapshot-ForzaLiveDashboard.png",
  },
  {
    name: "AccLiveDashboard",
    id: "dashboards-acclivedashboard--default",
    outputName: "snapshot-AccLiveDashboard.png",
  },
  {
    name: "SetupBrowser",
    id: "setups-setupbrowser--default",
    outputName: "snapshot-SetupBrowser.png",
  },
  {
    name: "SetupBrowserReadOnly",
    id: "setups-setupbrowser--read-only",
    outputName: "snapshot-SetupBrowserReadOnly.png",
  },
  {
    name: "ComboDash1",
    id: "dashes-combo-combo-dash-1--fm-2023",
    outputName: "snapshot-ComboDash1.png",
    viewport: { width: 874, height: 402 },
  },
  {
    name: "ComboDash2",
    id: "dashes-combo-combo-dash-2--fm-2023",
    outputName: "snapshot-ComboDash2.png",
    viewport: { width: 874, height: 402 },
  },
];

export const THEME_SNAPSHOT_CASE: StorybookSnapshotCase = {
  name: "theme semantic states",
  id: "design-system-theme-contract--states",
  outputName: "snapshot-theme-semantic-states.png",
  readyText: "Theme contract",
  hoverLabel: "Hover state",
};

export const STORYBOOK_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [...DASHBOARD_SNAPSHOT_CASES, THEME_SNAPSHOT_CASE];
