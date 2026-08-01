# Component-Owned Styling Design

## Goal

Finish PR #198 by moving repeated visual treatments into shared UI components. Consumers should select semantic variants rather than provide long Tailwind `className` overrides.

## Hard requirement

For migrated shared primitives, styling belongs to the primitive. Consumer `className` props are removed when they express appearance, including color, typography, padding, radius, border, hover, focus, active, alignment, and fixed control dimensions.

Consumer classes remain only when they express feature composition that the primitive cannot own: grid placement, outer spacing, responsive arrangement, positioning, width constrained by surrounding layout, or feature-specific wrapper layout.

## Scope

Audit every shared-primitive use changed by PR #198, including:

- `Button`
- `Badge`
- `Card` and card slots
- `Dialog` content, title, header, footer, and close controls
- `Tabs` root, list, trigger, and content
- shared table components
- `SearchSelect`, `SearchMultiSelect`, and menu primitives

Do not change domain behavior, routing, localization, data flow, or visualizations.

## API design

Add or refine CVA/data-state variants with semantic names. Variant names describe component intent, never Tailwind fragments.

Examples of permitted contracts:

- `Button`: menu action, close/icon action, destructive outline action, selected toggle action, full-width action.
- `Badge`: catalog category, game brand, compact status, AI flag, semantic status.
- `Card`: settings section, transparent panel, tune summary, bordered panel.
- `Dialog`: recurring shell sizes/layouts already present in `DialogContent`; add only repeated shell contracts.
- `Tabs`: trigger/list variants for the recurring tab-strip treatments; active state comes from component state or explicit semantic props.
- Select/menu/table primitives: own trigger, popup, item, row, and cell appearance through their APIs.

Variants must be reused by at least two callsites or represent a stable component-wide semantic contract. Do not create variants for a single accidental layout.

## Consumer migration

For each migrated callsite:

1. Identify whether each class is visual styling or feature composition.
2. Move repeated visual styling into the primitive variant or state API.
3. Replace the consumer usage with the semantic variant.
4. Delete the styling `className` entirely when no composition classes remain.
5. Preserve layout-only classes only where required by surrounding markup.

Before/after target:

```tsx
// Before
<Button variant="app-ghost" size="app-sm" className="w-full !justify-start !py-1 text-left text-app-text hover:bg-app-accent/20">

// After
<Button variant="menu-action">
```

```tsx
// Before
<Badge variant="neutral" size="compact" className="border-transparent text-xs font-bold">

// After
<Badge variant="catalog-category" size="compact">
```

No styling escape hatch or compatibility alias is added merely to avoid migration.

## Verification

- Search all PR #198-touched consumers for shared primitives with styling `className` props.
- Confirm remaining `className` props are documented layout/composition cases, not visual overrides.
- Add Storybook coverage for every new variant and representative consumer usage.
- Run client build and relevant Storybook/snapshot tests.
- Visually inspect representative controls, cards, badges, dialogs, tabs, menus, and selects for unchanged behavior and consistent styling.

## Success criteria

- Shared primitives own repeated visual contracts.
- PR #198 consumers no longer carry duplicated styling class strings.
- New variants have semantic names and documented usage.
- Remaining consumer classes are limited to layout/composition concerns.
- Existing accessibility, responsive behavior, localization, and product behavior remain intact.
