# Button Contract Cleanup Design

## Goal

Make shared `Button` own safe native-button behavior and reusable visual styling so consumers do not repeat `type="button"` or component-level visual classes.

## Contract

- `Button` defaults `type` to `"button"` and forwards explicit `"submit"` or `"reset"` values unchanged.
- Consumers omit `type` when they need normal action-button behavior.
- `variant` and `size` own reusable visual styling: color, border, radius, padding, typography, and icon geometry.
- `className` remains available for layout and contextual state: width, margin, alignment, conditional active state, and feature-specific CSS-variable styling.
- Repeated visual treatments become named shared variants or sizes. One-off layout composition does not.

## Scope

- Update `client/src/components/ui/button.tsx` to make the default explicit.
- Remove redundant `type="button"` from shared `Button` consumers across `client/src`.
- Audit PR #198 migrations and remove redundant visual `className` overrides already represented by a variant or size.
- Promote repeated missing visual treatments into shared variants or sizes, then migrate matching consumers.
- Preserve explicit submit/reset semantics and feature behavior.

## Non-goals

- Ban `className` from the component API.
- Create variants for margins, widths, flex placement, dynamic selected state, or feature-specific CSS-variable colors.
- Restyle unrelated assistant-ui components or change button behavior beyond defaults and equivalent visual consolidation.

## Verification

- Focused tests prove default, submit, and reset type behavior.
- Storybook Button stories render supported app variants and sizes without consumer visual overrides.
- Client TypeScript/build verification passes.
- React Doctor reports no new React diagnostics.
- Review resulting diff for preserved explicit form semantics and absence of redundant `type="button"` on shared `Button` consumers.
