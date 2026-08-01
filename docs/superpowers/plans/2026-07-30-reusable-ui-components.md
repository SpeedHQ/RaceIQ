# Reusable UI Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repeated common UI markup with shared shadcn/Base UI primitives so buttons, dialogs, tabs, badges, panels, tables, and overlays keep one visual contract.

**Architecture:** Extend existing components under `client/src/components/ui` before creating new abstractions. Add a Base UI-backed `Tabs` primitive and one semantic badge primitive, then migrate representative high-repetition callsites in dependency order: dialogs, tabs, buttons, badges, cards, tables, and overlays. Domain behavior, localized copy, route behavior, and chart/telemetry rendering remain in existing feature components.

**Tech Stack:** React 19, TypeScript, Base UI React 1.6, shadcn component conventions, Tailwind CSS v4, class-variance-authority, lucide-react, Storybook, Biome, Bun.

## Global Constraints

- Use existing shadcn/Base UI primitives before custom components.
- Preserve current behavior, keyboard access, labels, responsive behavior, and localized content.
- Use app semantic tokens (`app-*`, `status-*`) instead of new hard-coded colors.
- Keep domain behavior in callers; shared components own visual contracts and primitive interaction behavior.
- Do not introduce compatibility aliases or parallel primitives after migration.
- Do not refactor charts, telemetry diagrams, wireframes, or one-off layouts unless replacing an in-scope primitive.
- Verify each migration phase through affected UI routes or Storybook and focused tests for new observable contracts.

---

## File map

### Existing shared files to modify

- `client/src/components/ui/button.tsx` — only add button variants/sizes proven necessary by multiple migrated callsites.
- `client/src/components/ui/dialog.tsx` — add narrow size/layout variants to support migrated modal shells.
- `client/src/components/ui/card.tsx` — preserve shadcn API; adjust app-token styling only if adoption exposes a shared mismatch.
- `client/src/components/ui/AppTable.tsx` — extend exports for shared table primitives while preserving current helpers.
- `client/src/components/ui/SearchSelect.tsx` — align shared trigger/popup/item styling after overlay audit.
- `client/src/components/ui/SearchMultiSelect.tsx` — retain specialized behavior; align visual contract with shared select/menu styles.
- `client/src/components/ui/DropdownMenu.tsx` — align Base UI menu behavior and styling.

### New shared files

- `client/src/components/ui/tabs.tsx` — Base UI Tabs root/list/trigger/content wrappers.
- `client/src/components/ui/badge.tsx` — semantic badge/status pill variants.
- `client/src/stories/ReusableUi.stories.tsx` — focused visual coverage for new/changed primitives.

### Feature callsites by migration phase

- Dialogs: `SessionRecapModal.tsx`, `analyse/analysis-summary.tsx`, `analyse/IbtImportPreviewModal.tsx`, `analyse/ImportResultModal.tsx`, `analyse/MotecImportModal.tsx`, `comparison/CompareAiPanel.tsx`, `tunes/AddBaseModal.tsx`, `tunes/ImportLapsModal.tsx`, `tunes/HistoryPanel.tsx`, `tunes/VersionGraph.tsx`, `ui/NoteModal.tsx`, `routes/__root.tsx`.
- Tabs: `analyse/analysis-summary.tsx`, `setup-tune/FillForm.tsx`, `tunes/SetupFilePicker.tsx`.
- Buttons: `Settings.tsx`, `AiSection.tsx`, `SessionsPage.tsx`, `TuneForm.tsx`, `tune/TuneFormDialog.tsx`, `tunes/*`, plus repeated raw controls in `CarsPage.tsx`, `HomePage.tsx`, `ForzaLiveDashboard.tsx`, and `ac-evo/AcEvoCars.tsx` / `acc/AccCars.tsx`.
- Badges: `analyse/analysis-summary.tsx`, `F125TrackSetups.tsx`, `setup-tune/FillForm.tsx`, `tunes/ExperimentList.tsx`, and other repeated `status-*` pill callsites found by search.
- Cards: `TrackDetail.tsx`, `TuneForm.tsx`, `acc/AccTrackSetups.tsx`, `tunes/ExperimentList.tsx`, `HardwareSetup.tsx`, and repeated chart containers in comparison/analysis views.
- Tables: `F1LiveDashboard.tsx`, `TrackDetail.tsx`, `CarsPage.tsx`, `ChatsPage.tsx`, `f1/F1GridTable.tsx`, and analysis table views.
- Overlays: `ui/SearchSelect.tsx`, `ui/SearchMultiSelect.tsx`, `ui/DropdownMenu.tsx`, `analyse/AnalyseLapHeader.tsx`, and `tunes/SetupFilePicker.tsx`.

---

### Task 1: Add focused primitive stories and migration guardrails

**Files:**
- Create: `client/src/stories/ReusableUi.stories.tsx`
- Modify: `client/src/components/ui/button.tsx` only if story coverage exposes a missing shared variant.
- Modify: `client/src/components/ui/dialog.tsx` only if story coverage exposes a missing shared size/layout variant.

**Interfaces:**
- Consumes: Existing `Button`, `Dialog`, `Card`, `Input`, `Tooltip`, and `AppTable` exports.
- Produces: A stable visual test surface for later tasks: button app variants, dialog sizes, card shell, table shell, and eventually tabs/badge stories.

- [ ] **Step 1: Create stories for current primitives before migration.**

  Add stories that render the existing app button variants/sizes, a representative dialog, a card, and a table with semantic app tokens. Keep story content static and localized-looking; do not add production-only behavior to stories.

- [ ] **Step 2: Add interaction assertions for keyboard-visible contracts.**

  Assert that button focus is visible, dialog can close through its close control, and table structure renders `thead`, `tbody`, `th`, and `td`. Use the existing Storybook test conventions in `client/src/stories`.

- [ ] **Step 3: Run focused Storybook/type checks.**

  Run: `cd client && bun run build-storybook`
  Expected: existing stories and `ReusableUi.stories.tsx` build without TypeScript or Storybook errors.

- [ ] **Step 4: Commit the baseline coverage.**

  Run: `git add client/src/stories/ReusableUi.stories.tsx && git commit -m "test: add reusable UI primitive stories"`

---

### Task 2: Consolidate modal shells on Base UI Dialog

**Files:**
- Modify: `client/src/components/ui/dialog.tsx`
- Modify: all modal callsites listed under Dialogs in the file map, starting with `ui/NoteModal.tsx`, `SessionRecapModal.tsx`, and analysis import modals.
- Test: `client/src/stories/ReusableUi.stories.tsx`

**Interfaces:**
- Consumes: Existing `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, and `DialogDescription` exports.
- Produces: All migrated modal consumers use Base UI Dialog composition and `DialogContent` size/layout props or classes; no migrated consumer creates its own fixed portal/backdrop shell.

- [ ] **Step 1: Inventory each modal’s behavior before editing.**

  For each listed callsite record trigger ownership, controlled/open state, close behavior, focus behavior, width/max-height, scroll container, title/description semantics, and whether the modal has tabs or custom header actions. Preserve these behaviors in the new composition.

- [ ] **Step 2: Add only required DialogContent size variants.**

  Extend `DialogContent` with a typed `size` prop whose values encode observed shared dimensions, for example `sm`, `md`, `lg`, and `wide`. Map each to existing app surface, border, shadow, padding, max-height, and overflow tokens. Do not encode feature names in the primitive.

- [ ] **Step 3: Migrate the simplest modal shells first.**

  Convert `ui/NoteModal.tsx`, `SessionRecapModal.tsx`, `analyse/ImportResultModal.tsx`, and `analyse/IbtImportPreviewModal.tsx` to `Dialog` composition. Keep form contents and localized messages unchanged.

- [ ] **Step 4: Migrate complex/tabbed modal shells.**

  Convert `analyse/analysis-summary.tsx`, `analyse/MotecImportModal.tsx`, `comparison/CompareAiPanel.tsx`, `tunes/AddBaseModal.tsx`, `tunes/ImportLapsModal.tsx`, `tunes/HistoryPanel.tsx`, `tunes/VersionGraph.tsx`, and `routes/__root.tsx`. Keep feature-specific header controls inside `DialogHeader` or adjacent composition slots.

- [ ] **Step 5: Remove replaced portal/backdrop markup.**

  Delete only the duplicated modal shell markup after each callsite uses `Dialog`; do not leave wrapper aliases or dead shell classes.

- [ ] **Step 6: Verify modal behavior.**

  Run: `cd client && bun run build`
  Expected: client build succeeds. In Storybook or the affected route, verify opening, close button, Escape, backdrop behavior, focus visibility, and internal scrolling for small and large dialogs.

- [ ] **Step 7: Commit the modal migration.**

  Run: `git add client/src/components/ui/dialog.tsx client/src/components/ui/NoteModal.tsx client/src/components/SessionRecapModal.tsx client/src/components/analyse client/src/components/comparison/CompareAiPanel.tsx client/src/components/tunes client/src/routes/__root.tsx && git commit -m "refactor: standardize dialog shells"`

---

### Task 3: Add Base UI Tabs and migrate manual tab strips

**Files:**
- Create: `client/src/components/ui/tabs.tsx`
- Modify: `client/src/components/analyse/analysis-summary.tsx`
- Modify: `client/src/components/setup-tune/FillForm.tsx`
- Modify: `client/src/components/tunes/SetupFilePicker.tsx`
- Test: `client/src/stories/ReusableUi.stories.tsx`

**Interfaces:**
- Consumes: `Tabs.Root`, `Tabs.List`, `Tabs.Tab`, and `Tabs.Panel` from `@base-ui/react/tabs`; `cn` from `@/lib/utils`.
- Produces: `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent` exports with controlled/uncontrolled value support and consistent active/focus/disabled styling.

- [ ] **Step 1: Implement wrappers around Base UI Tabs.**

  Use the local Base UI parts API:

  ```tsx
  import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

  function Tabs(props: TabsPrimitive.Root.Props) {
    return <TabsPrimitive.Root data-slot="tabs" {...props} />;
  }
  ```

  Add list, trigger, and content wrappers with `data-slot` attributes and `cn`-merged classes. Keep values typed as strings and expose the underlying Base UI props.

- [ ] **Step 2: Define shared tab styling.**

  Match current app behavior: compact text, rounded trigger, muted inactive state, accent active state, visible focus ring, disabled state, and border-bottom list treatment. Do not change tab labels or indicator semantics.

- [ ] **Step 3: Add controlled and uncontrolled story cases.**

  Render one story using `defaultValue` and one using `value`/`onValueChange`, including a disabled trigger and keyboard navigation assertion.

- [ ] **Step 4: Migrate `FillForm`.**

  Keep `TAB_DEFS`, section grouping, active-data dot, and fallback `Other` tab. Replace manual `role=tablist`, button roles, `aria-selected`, and click-only state with `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent` values derived from tab labels or stable indexes.

- [ ] **Step 5: Migrate analysis and setup picker tabs.**

  Replace the manual tab strips in `analyse/analysis-summary.tsx` and `tunes/SetupFilePicker.tsx` while preserving active content, localized labels, disabled/empty behavior, and any existing state synchronization.

- [ ] **Step 6: Verify tab behavior.**

  Run: `cd client && bun run build`
  Expected: client build succeeds. In Storybook and affected routes, verify Arrow-key navigation, focus-visible styling, active content, disabled triggers, and responsive wrapping.

- [ ] **Step 7: Commit the tabs migration.**

  Run: `git add client/src/components/ui/tabs.tsx client/src/components/analyse/analysis-summary.tsx client/src/components/setup-tune/FillForm.tsx client/src/components/tunes/SetupFilePicker.tsx client/src/stories/ReusableUi.stories.tsx && git commit -m "feat: add shared tabs primitive"`

---

### Task 4: Standardize common buttons and status badges

**Files:**
- Create: `client/src/components/ui/badge.tsx`
- Modify: `client/src/components/ui/button.tsx` only for variants required by multiple callsites.
- Modify: `Settings.tsx`, `AiSection.tsx`, `SessionsPage.tsx`, `TuneForm.tsx`, `tune/TuneFormDialog.tsx`, `tunes/*`, `CarsPage.tsx`, `HomePage.tsx`, `ForzaLiveDashboard.tsx`, `ac-evo/AcEvoCars.tsx`, and `acc/AccCars.tsx`.
- Test: `client/src/stories/ReusableUi.stories.tsx`

**Interfaces:**
- Consumes: Existing `Button` props and `buttonVariants`; `cva`, `cn`, and app semantic tokens.
- Produces: `Badge` with semantic variants `neutral`, `info`, `success`, `warning`, and `danger`, plus `size` variants for compact and default pills.

- [ ] **Step 1: Add Badge primitive.**

  Implement a `Badge` component using `cva` with a typed `variant` and `size`, `cn`, `data-slot="badge"`, and `span` props. Keep business status mapping outside the component.

- [ ] **Step 2: Add badge stories.**

  Cover every semantic variant, compact/default sizes, long text wrapping behavior, and focus-independent decorative usage.

- [ ] **Step 3: Migrate repeated raw action buttons.**

  Replace common raw `<button>` elements with `Button`, selecting existing `app-outline`, `app-primary`, `app-ghost`, `app-danger`, and `app-sm/md/lg` combinations. Preserve `type`, `disabled`, `title`, `aria-label`, icons, and event handlers. Do not convert clickable cards or domain-specific sortable headers unless their visual contract matches a button.

- [ ] **Step 4: Migrate repeated status pills.**

  Replace equivalent `status-*`, accent, neutral, and info pill spans in analysis, setup, tuning, and experiment views with `Badge`. Keep `PiBadge` unchanged. Pass semantic variants explicitly at callsites.

- [ ] **Step 5: Add a missing Button variant only if evidence requires it.**

  If two or more migrated callsites need the same treatment not expressible by current variants, add one named semantic variant to `buttonVariants`, update its story, and migrate all matching callsites. Otherwise leave `button.tsx` unchanged.

- [ ] **Step 6: Verify action and status styling.**

  Run: `cd client && bun run build`
  Expected: client build succeeds. Verify disabled, destructive, icon-only, tooltip-labeled, and active/inactive controls in affected routes.

- [ ] **Step 7: Commit controls migration.**

  Run: `git add client/src/components/ui/badge.tsx client/src/components/ui/button.tsx client/src/components/Settings.tsx client/src/components/AiSection.tsx client/src/components/SessionsPage.tsx client/src/components/TuneForm.tsx client/src/components/tune/TuneFormDialog.tsx client/src/components/tunes client/src/components/CarsPage.tsx client/src/components/HomePage.tsx client/src/components/ForzaLiveDashboard.tsx client/src/components/ac-evo/AcEvoCars.tsx client/src/components/acc/AccCars.tsx client/src/stories/ReusableUi.stories.tsx && git commit -m "refactor: standardize shared buttons and badges"`

---

### Task 5: Adopt shared Card and panel shells

**Files:**
- Modify: `client/src/components/ui/card.tsx`
- Modify: `client/src/components/TrackDetail.tsx`
- Modify: `client/src/components/TuneForm.tsx`
- Modify: `client/src/components/acc/AccTrackSetups.tsx`
- Modify: `client/src/components/tunes/ExperimentList.tsx`
- Modify: `client/src/components/HardwareSetup.tsx`
- Modify: repeated chart container callsites in comparison/analysis views only where shell structure is identical.
- Test: `client/src/stories/ReusableUi.stories.tsx`

**Interfaces:**
- Consumes: Existing Card primitives and the shared Badge/Button/Dialog contracts from prior tasks.
- Produces: Repeated bordered surface shells use one Card/section structure with app semantic tokens; feature content remains unchanged.

- [ ] **Step 1: Compare existing Card API with app shell requirements.**

  Preserve the existing shadcn component exports. Add only stable app-token classes or a narrowly typed density variant if at least two target callsites require it.

- [ ] **Step 2: Migrate repeated panel shells.**

  Convert the identified `rounded-lg`/`rounded-xl` surface, border/ring, overflow, header, and body structures to `Card`, `CardHeader`, `CardTitle`, `CardDescription`, and `CardContent` where structure matches. Keep bespoke card internals and interactive card semantics in feature files.

- [ ] **Step 3: Verify visual parity.**

  Run: `cd client && bun run build-storybook`
  Expected: Storybook builds. Compare affected routes at desktop and narrow widths; verify borders, overflow, headers, and hover states remain equivalent.

- [ ] **Step 4: Commit card adoption.**

  Run: `git add client/src/components/ui/card.tsx client/src/components/TrackDetail.tsx client/src/components/TuneForm.tsx client/src/components/acc/AccTrackSetups.tsx client/src/components/tunes/ExperimentList.tsx client/src/components/HardwareSetup.tsx client/src/components/comparison client/src/components/analyse client/src/stories/ReusableUi.stories.tsx && git commit -m "refactor: adopt shared card shells"`

---

### Task 6: Establish shared table primitives and migrate raw tables

**Files:**
- Modify: `client/src/components/ui/AppTable.tsx`
- Modify: `client/src/components/F1LiveDashboard.tsx`
- Modify: `client/src/components/TrackDetail.tsx`
- Modify: `client/src/components/CarsPage.tsx`
- Modify: `client/src/components/ChatsPage.tsx`
- Modify: `client/src/components/f1/F1GridTable.tsx`
- Modify: analysis table views identified by search before implementation.
- Test: `client/src/stories/ReusableUi.stories.tsx`

**Interfaces:**
- Consumes: Existing `Table`, `THead`, `TBody`, `TRow`, `TH`, and `TD` helpers.
- Produces: Named shared table exports for standard markup while preserving existing helper compatibility during the migration task; after all callsites migrate, remove obsolete exports only if no references remain.

- [ ] **Step 1: Map current table variations.**

  Search all raw `<table>` callsites and classify sticky headers, responsive overflow, sortable headers, clickable rows, empty states, and special cell rendering. Exclude canvas/virtualized tables from migration and document each exclusion in the implementation commit.

- [ ] **Step 2: Extend the shared table API.**

  Add shadcn-style aliases/components only where they improve composition, using `cn` and native table props. Keep `AppTable` responsive overflow and app header/row defaults. Do not force one table layout on tables with materially different sticky or virtualized behavior.

- [ ] **Step 3: Migrate standard raw tables.**

  Convert `ChatsPage`, `F1GridTable`, and the simplest tables in `TrackDetail` and `CarsPage` first, then migrate F1 live and analysis tables that match the same structure. Preserve sort handlers, row click/context-menu handlers, sticky headers, and localized labels.

- [ ] **Step 4: Verify table contracts.**

  Run: `cd client && bun run build`
  Expected: client build succeeds. Verify responsive horizontal scrolling, sticky headers, sortable header focus/click behavior, row hover, empty states, and semantic table elements.

- [ ] **Step 5: Commit table migration.**

  Run: `git add client/src/components/ui/AppTable.tsx client/src/components/F1LiveDashboard.tsx client/src/components/TrackDetail.tsx client/src/components/CarsPage.tsx client/src/components/ChatsPage.tsx client/src/components/f1/F1GridTable.tsx client/src/components/analyse client/src/stories/ReusableUi.stories.tsx && git commit -m "refactor: standardize shared tables"`

---

### Task 7: Align Select and Menu overlay primitives

**Files:**
- Modify: `client/src/components/ui/SearchSelect.tsx`
- Modify: `client/src/components/ui/SearchMultiSelect.tsx`
- Modify: `client/src/components/ui/DropdownMenu.tsx`
- Modify: `client/src/components/analyse/AnalyseLapHeader.tsx`
- Modify: `client/src/components/tunes/SetupFilePicker.tsx`
- Test: `client/src/stories/ReusableUi.stories.tsx`

**Interfaces:**
- Consumes: Base UI Select/Menu primitives where behavior is standard; existing specialized search and multi-select state APIs.
- Produces: Shared trigger, popup, item, focus, selected, highlighted, and portal styling without removing required search/multi-select behavior.

- [ ] **Step 1: Compare overlay behavior and APIs.**

  Document which consumers need single-select, multi-select, free-text search, custom filtering, keyboard navigation, portal positioning, or action-menu semantics. Choose Base UI Select/Menu only for behavior it natively supports.

- [ ] **Step 2: Standardize shared overlay classes and slots.**

  Align surface, border, radius, padding, highlighted item, selected item, focus-visible, disabled, and z-index tokens. Keep specialized filtering and selection logic in `SearchSelect`/`SearchMultiSelect`.

- [ ] **Step 3: Migrate standard consumers.**

  Use the aligned components in `AnalyseLapHeader`, `SetupFilePicker`, and `DropdownMenu` consumers. Preserve labels, empty states, selected values, and pointer/keyboard behavior.

- [ ] **Step 4: Verify overlay behavior.**

  Run: `cd client && bun run build`
  Expected: client build succeeds. Verify open/close, keyboard navigation, selection, multi-selection, search filtering, collision positioning, and focus return.

- [ ] **Step 5: Commit overlay alignment.**

  Run: `git add client/src/components/ui/SearchSelect.tsx client/src/components/ui/SearchMultiSelect.tsx client/src/components/ui/DropdownMenu.tsx client/src/components/analyse/AnalyseLapHeader.tsx client/src/components/tunes/SetupFilePicker.tsx client/src/stories/ReusableUi.stories.tsx && git commit -m "refactor: align shared overlay components"`

---

### Task 8: Run final drift audit and update component guidance

**Files:**
- Modify: `client/src/stories/ReusableUi.stories.tsx` if final coverage is missing.
- Modify: `docs/superpowers/specs/2026-07-30-reusable-ui-components-design.md` only if implementation decisions materially differ from the approved design.
- Inspect: all `client/src/**/*.tsx` files for remaining raw common primitive copies.

**Interfaces:**
- Consumes: All shared primitives and migrated callsites from Tasks 1–7.
- Produces: Evidence that priority duplicated patterns are removed or intentionally documented as domain-specific exceptions.

- [ ] **Step 1: Search for remaining duplicated primitive markup.**

  Search for raw `<button>`, manual `role="tablist"`, repeated portal/backdrop shells, repeated badge classes, raw standard tables, and repeated select/menu popup classes. Classify every remaining match as migrated, domain-specific, or requiring follow-up.

- [ ] **Step 2: Remove dead imports and obsolete helpers.**

  Delete unused imports and custom shell helpers created solely for replaced markup. Do not leave aliases, deprecated paths, or duplicate primitives.

- [ ] **Step 3: Run focused and project verification.**

  Run: `cd client && bun run lint`
  Expected: Biome reports no errors.

  Run: `cd client && bun run build`
  Expected: TypeScript and Vite build succeed.

  Run: `cd client && bun run build-storybook`
  Expected: Storybook build succeeds.

  Run: `bun test test/theme-contract.test.ts test/collect-screenshot-diffs.test.ts --timeout 30000`
  Expected: relevant existing UI contract tests pass, or any unrelated baseline failure is recorded with its exact output.

- [ ] **Step 4: Commit final cleanup.**

  Run: `git add client/src docs/superpowers/specs/2026-07-30-reusable-ui-components-design.md && git commit -m "chore: finish reusable UI component audit"`
