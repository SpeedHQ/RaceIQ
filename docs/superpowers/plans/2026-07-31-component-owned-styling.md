# Component-Owned Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove repeated styling `className` overrides from PR #198 consumers by giving shared UI primitives semantic variants that own their visual treatment.

**Architecture:** Extend existing CVA/data-state APIs in `client/src/components/ui` with semantic variants. Migrate consumers in component-focused batches; consumers retain only unavoidable layout/composition classes. Storybook becomes the executable contract for each new variant and the final audit verifies that styling overrides are gone.

**Tech Stack:** React, TypeScript, Tailwind CSS v4, class-variance-authority, Base UI, Storybook, Bun.

## Global Constraints

- Shared primitives own complete visual treatment; consumer styling `className` props are removed.
- Consumer classes remain only for grid placement, outer spacing, responsive arrangement, positioning, surrounding-layout width, or feature-specific wrapper layout.
- Variant names encode semantic intent, never Tailwind fragments.
- Add a variant only when reused by at least two callsites or when it is a stable component-wide semantic contract.
- Preserve behavior, accessibility, localization, responsive behavior, routing, data flow, and visualizations.
- Do not add compatibility aliases or styling escape hatches to avoid migration.
- Do not modify existing user changes in `assets/screenshots/ForzaLiveDashboard.png` or its snapshot unless verification explicitly requires a regenerated baseline.

---

## Task 1: Define semantic variant contracts and stories

**Files:**
- Modify: `client/src/components/ui/button.tsx`
- Modify: `client/src/components/ui/badge.tsx`
- Modify: `client/src/components/ui/card.tsx`
- Modify: `client/src/components/ui/dialog.tsx`
- Modify: `client/src/components/ui/tabs.tsx`
- Modify: `client/src/components/ui/AppTable.tsx`
- Modify: `client/src/components/ui/SearchSelect.tsx`
- Modify: `client/src/components/ui/SearchMultiSelect.tsx`
- Modify: `client/src/components/ui/DropdownMenu.tsx`
- Modify: `client/src/stories/ReusableUi.stories.tsx`

**Interfaces:**
- Existing callers continue to use current `variant`, `size`, and controlled-state props.
- New semantic variants are additive and exported through each component’s existing variant function where one exists.
- New component-specific props must be typed unions, not arbitrary strings.

- [ ] **Step 1: Inventory repeated visual combinations before editing.**
  Search PR #198-touched consumers for shared primitives with `className`. Group exact repeated combinations by primitive and semantic intent. Do not turn a single layout combination into a variant.

- [ ] **Step 2: Add Button semantic variants.**
  Extend `buttonVariants` with only repeated treatments found in the inventory, including the menu-action, close/icon-action, destructive-outline, selected-toggle, and full-width-action contracts where callsites support them. Keep `type="button"` default and explicit `type` forwarding unchanged. Encode padding, border, color, hover, alignment, and fixed control dimensions in these variants.

- [ ] **Step 3: Add Badge semantic variants.**
  Extend `badgeVariants` with catalog-category and game-brand treatments plus any repeated AI/status treatment confirmed by the inventory. Preserve `variant`/`size` compatibility for existing semantic statuses. Encode border, font, color, and surface styling in the variant.

- [ ] **Step 4: Add Card and slot variants.**
  Add named contracts for repeated bordered settings sections, transparent panels, tune summaries, and other repeated panel shells. Ensure `CardHeader` and `CardContent` styling follows the parent card contract without requiring consumer overrides. Do not encode consumer grid placement or outer margins.

- [ ] **Step 5: Refine Dialog and Tabs contracts.**
  Keep `DialogContent` size variants for recurring shell dimensions and add only repeated shell layout treatments. Move repeated tab list/trigger active, focus, padding, and border treatments into the Tabs primitives; preserve controlled and uncontrolled behavior.

- [ ] **Step 6: Refine table, select, and menu styling APIs.**
  Move recurring trigger, popup, item, row, head, and cell appearance into their shared primitives. Preserve specialized filtering and multi-select behavior. Do not replace feature behavior with generic controls.

- [ ] **Step 7: Add Storybook contract coverage.**
  Add stories/render assertions for every new variant. Each story must show semantic variants in representative states and assert observable behavior where relevant (button rendered type, selected tab state, dialog open/close, disabled state, or accessible labels). Remove any story-only styling `className` that duplicates a primitive variant; retain story layout classes only when needed to arrange examples.

- [ ] **Step 8: Run focused Storybook checks.**
  Run `cd client && bun run build-storybook` and the focused reusable UI/story tests available in the repository. Expected: all new variant stories render and existing stories remain valid.

- [ ] **Step 9: Commit the contract changes.**
  ```bash
  git add client/src/components/ui client/src/stories/ReusableUi.stories.tsx
  git commit -m "feat(ui): add semantic component variants"
  ```

---

## Task 2: Migrate control and status consumers

**Files:**
- Modify: `client/src/components/AppSidebar.tsx`
- Modify: `client/src/components/CarsPage.tsx`
- Modify: `client/src/components/DevStateViewer.tsx`
- Modify: `client/src/components/ExportButton.tsx`
- Modify: `client/src/components/LapList.tsx`
- Modify: `client/src/components/Settings.tsx`
- Modify: `client/src/components/UpdateModal.tsx`
- Modify: `client/src/components/ac-evo/AcEvoCars.tsx`
- Modify: `client/src/components/acc/AccCars.tsx`
- Modify: `client/src/components/ai/analysis-summary.tsx`
- Modify: `client/src/components/analyse/AnalyseLapHeader.tsx`
- Modify: `client/src/components/analyse/ImportResultModal.tsx`
- Modify: `client/src/components/analyse/MotecImportModal.tsx`
- Modify: `client/src/components/comparison/CompareAiPanel.tsx`
- Modify: `client/src/components/settings/AiSection.tsx`
- Modify: `client/src/components/settings/UpdatesSection.tsx`
- Modify: `client/src/components/tunes/BackButton.tsx`
- Modify: `client/src/components/tunes/FocusPicker.tsx`
- Modify: `client/src/components/tunes/FocusSwitcher.tsx`
- Modify: `client/src/components/tunes/IssuesList.tsx`
- Modify: `client/src/components/tunes/SectorHeatmap.tsx`
- Modify: `client/src/components/tunes/TiresPanel.tsx`
- Modify: `client/src/components/tunes/TrackFocusView.tsx`

**Interfaces:**
- Consume Task 1 semantic variants without adding local styling aliases.
- Preserve dynamic state by selecting semantic `variant`/state props, not by assembling Tailwind strings in the consumer.

- [ ] **Step 1: Migrate button consumers.**
  Replace visual `className` overrides on Buttons with the matching semantic variant. Delete `className` when no layout class remains. Keep only classes that position the control in its parent layout.

- [ ] **Step 2: Migrate badge consumers.**
  Replace catalog, game-brand, AI flag, and status badge class combinations with semantic Badge variants. Preserve `data-*` attributes and consumer positioning classes only where they affect placement.

- [ ] **Step 3: Migrate close and toggle controls.**
  Replace close-button and selected/unselected visual class logic with Button variants or explicit component state props. Preserve accessible labels and keyboard behavior.

- [ ] **Step 4: Audit this file group.**
  Search these files for shared primitive `className` props. For every remaining match, verify it is layout/composition-only; remove any remaining appearance class.

- [ ] **Step 5: Run focused checks.**
  Run the relevant Storybook stories and `cd client && bun run build`. Expected: controls and badges render with unchanged behavior and no TypeScript errors.

- [ ] **Step 6: Commit the consumer migration.**
  ```bash
  git add client/src/components/AppSidebar.tsx client/src/components/CarsPage.tsx client/src/components/DevStateViewer.tsx client/src/components/ExportButton.tsx client/src/components/LapList.tsx client/src/components/Settings.tsx client/src/components/UpdateModal.tsx client/src/components/ac-evo/AcEvoCars.tsx client/src/components/acc/AccCars.tsx client/src/components/ai/analysis-summary.tsx client/src/components/analyse/AnalyseLapHeader.tsx client/src/components/analyse/ImportResultModal.tsx client/src/components/analyse/MotecImportModal.tsx client/src/components/comparison/CompareAiPanel.tsx client/src/components/settings/AiSection.tsx client/src/components/settings/UpdatesSection.tsx client/src/components/tunes
  git commit -m "refactor(ui): remove control styling overrides"
  ```

---

## Task 3: Migrate panel, dialog, tab, and table consumers

**Files:**
- Modify: `client/src/components/HardwareSetup.tsx`
- Modify: `client/src/components/HomePage.tsx`
- Modify: `client/src/components/TuneForm.tsx`
- Modify: `client/src/components/SessionRecapModal.tsx`
- Modify: `client/src/components/analyse/IbtImportPreviewModal.tsx`
- Modify: `client/src/components/analyse/MotecImportModal.tsx`
- Modify: `client/src/components/analyse/WheelTable.tsx`
- Modify: `client/src/components/comparison/CompareTrackMap.tsx`
- Modify: `client/src/components/f1/F1GridTable.tsx`
- Modify: `client/src/components/f1/F1LiveDashboard.tsx`
- Modify: `client/src/components/track/TrackDetail.tsx`
- Modify: `client/src/components/tune/TuneFormDialog.tsx`
- Modify: `client/src/components/tunes/AddBaseModal.tsx`
- Modify: `client/src/components/tunes/ExperimentList.tsx`
- Modify: `client/src/components/tunes/ExperimentWorkspace.tsx`
- Modify: `client/src/components/tunes/HistoryPanel.tsx`
- Modify: `client/src/components/tunes/ImportLapsModal.tsx`
- Modify: `client/src/components/tunes/SectorDetailView.tsx`
- Modify: `client/src/components/tunes/SetupEngineer.tsx`
- Modify: `client/src/components/tunes/SetupFilePicker.tsx`
- Modify: `client/src/components/tunes/TestReviewPage.tsx`
- Modify: `client/src/components/tunes/TuneReviewDashboard.tsx`
- Modify: `client/src/components/tunes/VersionGraph.tsx`
- Modify: `client/src/components/tunes/tune-version-shared.tsx`
- Modify: `client/src/routes/__root.tsx`

**Interfaces:**
- Consume Task 1 Card, Dialog, Tabs, and table contracts.
- Keep feature-specific content markup and event/data behavior unchanged.

- [ ] **Step 1: Migrate repeated Card shells.**
  Replace card surface, border, radius, padding, header divider, and content padding overrides with Card/slot variants. Keep only outer layout classes such as `mb-3`, `col-span-2`, `flex-1`, or responsive placement.

- [ ] **Step 2: Migrate Dialog shells and close controls.**
  Replace repeated width, max-height, overflow, surface, border, and close-button styling with DialogContent size/layout variants and shared close-button variants. Preserve each modal’s content, portal behavior, close semantics, and localized labels.

- [ ] **Step 3: Migrate tab strips.**
  Replace active trigger/list padding, border, typography, and focus classes with Tabs variants/state. Preserve tab values, controlled behavior, keyboard navigation, and content rendering.

- [ ] **Step 4: Migrate tables.**
  Replace repeated table shell, header, row, and cell appearance with AppTable/shared table APIs. Preserve sorting, sticky headers, responsive overflow, row actions, and feature-specific cell content.

- [ ] **Step 5: Migrate route-level shared controls.**
  Update `client/src/routes/__root.tsx` and dashboard-level consumers so shared primitives no longer receive appearance overrides. Do not alter route behavior.

- [ ] **Step 6: Audit this file group.**
  Search for shared primitive `className` props and classify every remaining class as layout/composition-only. Remove all appearance overrides.

- [ ] **Step 7: Run focused checks.**
  Run `cd client && bun run build-storybook`, `cd client && bun run snapshot:test -- src/stories/dashboards.snapshot.ts`, and `cd client && bun run build`. Expected: dialogs, tabs, cards, and tables preserve behavior and render consistently.

- [ ] **Step 8: Commit the migration.**
  ```bash
  git add client/src/components client/src/routes/__root.tsx
  git commit -m "refactor(ui): centralize panel and overlay styling"
  ```

---

## Task 4: Migrate select and menu consumers and complete audit

**Files:**
- Modify: `client/src/components/ui/SearchSelect.tsx`
- Modify: `client/src/components/ui/SearchMultiSelect.tsx`
- Modify: `client/src/components/ui/DropdownMenu.tsx`
- Modify: `client/src/components/analyse/MotecImportModal.tsx`
- Modify: `client/src/components/setup-tune/FillForm.tsx`
- Modify: `client/src/components/setup-tune/ImportSetupFile.tsx`
- Modify: `client/src/components/setup-tune/SetupTuneForm.tsx`
- Modify: `client/src/components/tunes/SetupFilePicker.tsx`
- Modify: `client/src/components/tunes/FocusPicker.tsx`
- Modify: `client/src/components/tunes/FocusSwitcher.tsx`
- Modify: `client/src/components/assistant-ui/thread.tsx`
- Modify: `client/src/components/assistant-ui/tool-fallback.tsx`
- Modify: `client/src/components/assistant-ui/tooltip-icon-button.tsx`

**Interfaces:**
- Preserve specialized search, multi-selection, menu actions, assistant interactions, and tooltip behavior.
- Use shared semantic variants from Task 1; do not expose raw Tailwind styling through new consumer props.

- [ ] **Step 1: Centralize trigger and popup styling.**
  Move recurring trigger dimensions, borders, surfaces, item spacing, focus, and selected states into SearchSelect/SearchMultiSelect/DropdownMenu APIs. Keep search filtering, option rendering, and selection behavior unchanged.

- [ ] **Step 2: Migrate select/menu callsites.**
  Remove appearance classes from Motec import fields, setup-tune pickers, focus controls, and assistant menu actions. Retain only wrapper layout classes such as margins or flex placement.

- [ ] **Step 3: Audit all PR #198-touched files.**
  Search the complete touched-file set for `<Button`, `<Badge`, `<Card`, `<Dialog`, `<Tabs`, shared table, select, and menu usages with `className`. Review each match manually. Any class containing color, typography, padding, border, radius, hover/focus/active, alignment, or fixed control sizing must be moved into a component variant or removed.

- [ ] **Step 4: Add an audit note to Storybook coverage.**
  Keep representative examples for each semantic variant and add a story-level example demonstrating that consumers use variants without styling overrides. Do not add a runtime lint rule unless the existing tooling supports it without introducing a new dependency.

- [ ] **Step 5: Run final verification.**
  Run:
  ```bash
  cd client && bun run build
  cd client && bun run build-storybook
  ```
  Run `cd client && bun run build`, `cd client && bun run build-storybook`, and `cd client && bun run snapshot:test -- src/stories/dashboards.snapshot.ts`. Expected: builds pass; component stories and affected snapshots pass or are intentionally updated only when the component-owned styling changes the approved baseline.

- [ ] **Step 6: Commit the final audit.**
  ```bash
  git add client/src/components client/src/stories/ReusableUi.stories.tsx
  git commit -m "refactor(ui): finish consumer styling audit"
  ```

---

## Final review checklist

- [ ] Every new variant has a semantic name and a Storybook example.
- [ ] No duplicated visual Tailwind strings remain on migrated shared primitives.
- [ ] Remaining consumer `className` props are layout/composition-only.
- [ ] Button default and explicit `type` behavior remains correct.
- [ ] Dialog close, tab keyboard navigation, select search, and menu actions remain accessible.
- [ ] Existing user changes to dashboard screenshot assets remain untouched unless snapshot verification requires a deliberate update.
- [ ] `bun run build`, Storybook build, and affected UI tests have fresh passing output.
