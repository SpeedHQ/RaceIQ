export interface StorybookSnapshotCase {
  name: string;
  id: string;
  outputName: string;
  viewport?: { width: number; height: number };
  readyText?: string;
  hoverLabel?: string;
  clickLabel?: string;
  readyRole?: "dialog" | "listbox" | "menu";
  readyName?: string;
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

export const REUSABLE_UI_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [
  {
    name: "ReusableButtons",
    id: "ui-reusable-primitives--button-variants",
    outputName: "snapshot-ReusableButtons.png",
    viewport: { width: 900, height: 650 },
  },
  {
    name: "ReusableBadges",
    id: "ui-reusable-primitives--badge-variants",
    outputName: "snapshot-ReusableBadges.png",
    viewport: { width: 900, height: 650 },
  },
  {
    name: "ReusableTabs",
    id: "ui-reusable-primitives--tabs-uncontrolled",
    outputName: "snapshot-ReusableTabs.png",
    viewport: { width: 900, height: 650 },
  },
  {
    name: "ReusableDialog",
    id: "ui-reusable-primitives--dialog-sizes",
    outputName: "snapshot-ReusableDialog.png",
    viewport: { width: 900, height: 700 },
    clickLabel: "Open lap summary",
    readyRole: "dialog",
  },
  {
    name: "ReusableCard",
    id: "ui-reusable-primitives--card-shell",
    outputName: "snapshot-ReusableCard.png",
    viewport: { width: 900, height: 650 },
  },
  {
    name: "ReusableTable",
    id: "ui-reusable-primitives--table-shell",
    outputName: "snapshot-ReusableTable.png",
    viewport: { width: 900, height: 650 },
  },
  {
    name: "ReusableSearchSelect",
    id: "ui-reusable-primitives--search-select-menu",
    outputName: "snapshot-ReusableSearchSelect.png",
    viewport: { width: 900, height: 650 },
    readyRole: "listbox",
    readyName: "Search tracks...",
  },
  {
    name: "ReusableSearchMultiSelect",
    id: "ui-reusable-primitives--search-multi-select-menu",
    outputName: "snapshot-ReusableSearchMultiSelect.png",
    viewport: { width: 900, height: 650 },
    readyRole: "listbox",
    readyName: "Search classes...",
  },
  {
    name: "ReusableDropdownMenu",
    id: "ui-reusable-primitives--dropdown-menu-open",
    outputName: "snapshot-ReusableDropdownMenu.png",
    viewport: { width: 900, height: 650 },
    readyRole: "menu",
  },
];

export const COMMITTED_STORYBOOK_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [...DASHBOARD_SNAPSHOT_CASES, THEME_SNAPSHOT_CASE];
export const STORYBOOK_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [...COMMITTED_STORYBOOK_SNAPSHOT_CASES, ...REUSABLE_UI_SNAPSHOT_CASES];
