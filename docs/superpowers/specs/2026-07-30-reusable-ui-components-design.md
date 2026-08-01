# Reusable UI Components Design

## Goal

Reduce duplicated common UI markup in `client/src` and prevent style drift by standardizing shared controls on existing shadcn/Base UI primitives. Add new shared primitives only where current coverage is missing.

## Scope

Prioritize shared primitives, not domain-specific feature components:

1. Modal and dialog shells.
2. Tabs.
3. Buttons and icon buttons.
4. Status pills and badges.
5. Card and panel shells.
6. Tables.
7. Select and menu overlays.

Domain-specific visualizations, charts, telemetry diagrams, and one-off feature layouts remain outside this effort unless they contain one of these repeated primitives.

## Existing component inventory

Existing Base UI/shadcn-oriented components under `client/src/components/ui`:

- `button.tsx`: Base UI Button with CVA variants, including app-specific variants and sizes.
- `dialog.tsx`: Base UI Dialog with app styling and close-button support.
- `input.tsx`, `label.tsx`, `avatar.tsx`, `collapsible.tsx`, and `tooltip.tsx`.
- `card.tsx`: existing shadcn card primitive, currently underused.
- `AppTable.tsx`: app-specific table wrapper and row/cell helpers, partially adopted.
- `SearchSelect.tsx`, `SearchMultiSelect.tsx`, `DropdownMenu.tsx`, and `NoteModal.tsx`: custom components with overlapping overlay or modal responsibilities.

`@base-ui/react`, `shadcn`, `class-variance-authority`, and `lucide-react` are already dependencies. New primitives should follow the existing `components.json` aliases and Base UI-backed style.

## Repeated patterns and migration order

### 1. Dialog shells

Many components duplicate `createPortal`, fixed backdrop, centering, width, max-height, border, shadow, and padding classes. Representative locations include:

- `SessionRecapModal.tsx`.
- `analyse/analysis-summary.tsx`.
- `analyse/IbtImportPreviewModal.tsx`.
- `analyse/ImportResultModal.tsx`.
- `analyse/MotecImportModal.tsx`.
- `comparison/CompareAiPanel.tsx`.
- `tunes/AddBaseModal.tsx`, `ImportLapsModal.tsx`, `HistoryPanel.tsx`, and `VersionGraph.tsx`.
- `ui/NoteModal.tsx` and `routes/__root.tsx`.

Use `Dialog` and `DialogContent` as the common shell. Extend `ui/dialog.tsx` with narrowly scoped size/layout variants only when existing consumers need materially different dimensions. Preserve feature-specific headers, tabs, forms, and portal behavior through composition rather than another modal implementation.

### 2. Tabs

Manual tab strips repeat `role=tablist`, `aria-selected`, active-state classes, and keyboard behavior in:

- `analyse/analysis-summary.tsx`.
- `setup-tune/FillForm.tsx`.
- `tunes/SetupFilePicker.tsx`.

Add `ui/tabs.tsx` using a Base UI/shadcn-compatible API. It must expose root, list, trigger, and content pieces, preserve controlled and uncontrolled usage, and provide consistent active, focus, disabled, and orientation styling. Migrate these callsites first.

### 3. Buttons

Replace raw styled `<button>` elements used for common actions with `ui/button.tsx`. Prioritize `Settings.tsx`, `AiSection.tsx`, `SessionsPage.tsx`, `TuneForm.tsx`, `tune/TuneFormDialog.tsx`, and `tunes/*`. Reuse existing `app-*` variants and sizes. Add a variant only when multiple callsites share a stable semantic treatment that cannot be expressed by current variants. Icon-only controls must use the existing icon sizes and accessible labels.

### 4. Status pills and badges

Repeated status spans use inconsistent combinations of semantic colors, padding, radius, and typography in analysis, setup, tuning, and experiment views. Add one small shared `Badge` or `StatusPill` primitive with semantic variants for neutral, success, warning, danger, and info states. Keep `forza/PiBadge.tsx` separate because PI presentation is domain-specific. Avoid making the primitive responsible for business status mapping; callers supply the semantic variant.

### 5. Cards and panels

Adopt `ui/card.tsx` for repeated bordered surface shells in `TrackDetail.tsx`, `TuneForm.tsx`, `acc/AccTrackSetups.tsx`, `tunes/ExperimentList.tsx`, `HardwareSetup.tsx`, and repeated chart containers. Add app-specific card classes or section variants only when they encode stable shared structure. Do not wrap every arbitrary div; componentize repeated visual contracts, not incidental markup.

### 6. Tables

Raw table markup remains in multiple feature areas, including F1 live dashboards, track detail, cars, chats, F1 grid, and analysis views. Define `AppTable` as the default shared table layer, extending it or adding shadcn-style `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, and `TableCell` exports where needed. Preserve feature-specific sorting, sticky headers, responsive overflow, and cell content. New tables must use the shared layer unless a documented canvas or virtualization constraint prevents it.

### 7. Select and menu overlays

Compare `SearchSelect`, `SearchMultiSelect`, `DropdownMenu`, `AnalyseLapHeader`, and `tunes/SetupFilePicker`. Use Base UI Select/Menu for standard single-select and action-menu behavior. Retain specialized multi-select behavior where search, multiple selection, or custom filtering cannot be represented cleanly. Align trigger, popup, item, focus, and portal styles through shared tokens and APIs rather than duplicating classes.

## Design principles

- Existing shadcn/Base UI primitive before custom component.
- One visual contract per shared component; domain behavior stays in callers.
- Composition over feature-specific wrappers.
- Preserve current public behavior, keyboard access, labels, responsive behavior, and localized content.
- Migrate representative high-frequency callsites before expanding scope.
- Do not introduce compatibility aliases or parallel primitives after migration.

## Verification

Each migration phase must verify the affected route or Storybook story visually and interactively, including keyboard focus and modal/tab transitions where applicable. Add focused component stories or tests only for new observable contracts: variant behavior, controlled/uncontrolled tabs, dialog close behavior, semantic badge states, and table structure. Run the existing client typecheck/build and relevant UI tests after each completed phase.

## Non-goals

- Rebuilding the entire design system in one pass.
- Replacing domain-specific charts, telemetry visualizations, or wireframe components.
- Changing product behavior, route behavior, data flow, or localization.
- Introducing a new styling framework or replacing Tailwind v4.
- Abstracting one-off markup solely to reduce line count.

## Success criteria

- Common modal, tab, button, badge, card, and table patterns have one documented shared implementation path.
- Priority callsites no longer duplicate equivalent primitive markup or style classes.
- New shared primitives use Base UI/shadcn conventions and app semantic tokens.
- Existing accessibility, responsive behavior, localization, and feature behavior remain intact.
- Future component work has a clear rule for choosing shared primitives over inline copies.
