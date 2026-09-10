export interface StorybookSnapshotCase {
  name: string;
  id: string;
  outputName: string;
  fullPage?: boolean;
  screenshotTarget?: string;
  readyText?: string;
  hoverLabel?: string;
  clickLabel?: string;
  clickRole?: "button" | "combobox";
  readyRole?: "dialog" | "listbox" | "menu";
  readyName?: string;
  viewport?: { width: number; height: number };
}

// Single screenshot inventory for CI and `bun run ui:diff`.
// Every case names a dedicated export. Shared layouts use comprehensive All Data
// or All States stories; separate cases exist only for layout or interaction
// contracts. Simulator capability differences belong in behavioral tests.
// Never select a default or first export implicitly.
export const DASHBOARD_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [
  // Distinct baselines: each simulator owns a different live-dashboard layout.
  {
    name: "F1LiveDashboard",
    id: "dashboards-f1livedashboard--visual-contract",
    outputName: "snapshot-F1LiveDashboard.png",
  },
  {
    name: "ForzaLiveDashboard",
    id: "dashboards-forzalivedashboard--visual-contract",
    outputName: "snapshot-ForzaLiveDashboard.png",
  },
  {
    name: "AccLiveDashboard",
    id: "dashboards-acclivedashboard--visual-contract",
    outputName: "snapshot-AccLiveDashboard.png",
  },
  // Distinct interaction contract: read-only setup browsing removes owner actions.
  {
    name: "SetupBrowser",
    id: "setups-setupbrowser--all-data",
    outputName: "snapshot-SetupBrowser.png",
  },
  {
    name: "SetupBrowserReadOnly",
    id: "setups-setupbrowser--all-data-read-only",
    outputName: "snapshot-SetupBrowserReadOnly.png",
  },
  // Shared Combo layouts use simulator-independent fixtures with every supported field.
  {
    name: "ComboDash1",
    id: "dashes-combo-combo-dash-1--all-data",
    outputName: "snapshot-ComboDash1.png",
    viewport: { width: 874, height: 402 },
  },
  {
    name: "ComboDash2",
    id: "dashes-combo-combo-dash-2--all-data",
    outputName: "snapshot-ComboDash2.png",
    viewport: { width: 874, height: 402 },
  },
];

// Dedicated All States story covers semantic text and interaction states together.
export const THEME_SNAPSHOT_CASE: StorybookSnapshotCase = {
  name: "theme semantic states",
  id: "design-system-theme-contract--states",
  outputName: "snapshot-theme-semantic-states.png",
  readyText: "Theme contract",
  hoverLabel: "Hover state",
};

export const REUSABLE_UI_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [
  // Primitive stories enumerate visual variants or hold one deterministic open state.
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
    name: "ReusableAvatars",
    id: "ui-reusable-primitives--avatar-variants",
    outputName: "snapshot-ReusableAvatars.png",
    viewport: { width: 900, height: 650 },
  },
  {
    name: "ReusableCollapsible",
    id: "ui-reusable-primitives--collapsible-states",
    outputName: "snapshot-ReusableCollapsible.png",
    viewport: { width: 900, height: 650 },
  },
  {
    name: "ReusableNoteModal",
    id: "ui-reusable-primitives--note-modal-open",
    outputName: "snapshot-ReusableNoteModal.png",
    viewport: { width: 900, height: 700 },
    clickLabel: "Open note",
    readyRole: "dialog",
  },
  {
    name: "ReusablePanelSectionHeader",
    id: "ui-reusable-primitives--panel-section-header-states",
    outputName: "snapshot-ReusablePanelSectionHeader.png",
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
    clickRole: "combobox",
    clickLabel: "Search tracks...",
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
  // Analysis panels use complete fixed frames; open menu is a distinct interaction state.
  {
    name: "AnalyseDataPanelParity",
    id: "screens-analysedatapanelparity--loaded-main-parity",
    outputName: "snapshot-AnalyseDataPanelParity.png",
    viewport: { width: 1080, height: 800 },
    screenshotTarget: "body",
  },
  {
    name: "AnalyseVizPanel3D",
    id: "screens-analysevizpanel--three-d",
    outputName: "snapshot-AnalyseVizPanel3D.png",
    viewport: { width: 1080, height: 800 },
  },
  {
    name: "AnalyseVizPanel3DViewMenuOpen",
    id: "screens-analysevizpanel--three-d-view-menu-open",
    outputName: "snapshot-AnalyseVizPanel3DViewMenuOpen.png",
    viewport: { width: 1080, height: 800 },
    readyRole: "menu",
  },
  {
    name: "AnalyseTrackPanel",
    id: "screens-analysevizpanel--track-display",
    outputName: "snapshot-AnalyseTrackPanel.png",
    viewport: { width: 1080, height: 800 },
  },
];
export const CORE_STORYBOOK_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [...DASHBOARD_SNAPSHOT_CASES, THEME_SNAPSHOT_CASE];
export const STORYBOOK_SNAPSHOT_CASES: readonly StorybookSnapshotCase[] = [...CORE_STORYBOOK_SNAPSHOT_CASES, ...REUSABLE_UI_SNAPSHOT_CASES];
