# Button Contract Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement these tasks in parallel. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shared `Button` own safe native type defaults and reusable visual styling while removing redundant consumer props from PR #198.

**Architecture:** `client/src/components/ui/button.tsx` remains the single button contract. Six parallel slices update the primitive, coverage, and disjoint consumer groups; visual classes move into existing or demonstrably reusable variants/sizes, while layout and contextual state remain composable through `className`.

**Tech Stack:** React 19, TypeScript 7, Base UI 1.6, class-variance-authority, Tailwind CSS 4, Storybook 10, Bun.

## Global Constraints

- `Button` defaults `type` to `"button"`; explicit `"submit"` and `"reset"` pass through unchanged.
- Remove redundant `type="button"` only from shared `<Button>` consumers, never native `<button>` elements.
- Variants and sizes own reusable color, border, radius, padding, typography, and icon geometry.
- `className` remains for layout, conditional state, and feature-specific CSS-variable styling.
- Do not add one-callsite variants or restyle unrelated UI.
- Each subagent skips builds, linters, formatters, and project-wide tests; main agent validates once after integration.

---

### Task 1: Shared Button Contract and Story Coverage

**Files:**
- Modify: `client/src/components/ui/button.tsx`
- Modify: `client/src/stories/ReusableUi.stories.tsx`

**Interfaces:**
- Produces: `Button` with `type = "button"` wrapper default and unchanged `ButtonPrimitive.Props & VariantProps<typeof buttonVariants>` public props.
- Produces: story assertions for default, submit, and reset button types.

- [ ] **Step 1:** Extend `ButtonVariants` rendering with named default, submit, and reset examples.
- [ ] **Step 2:** Extend its `play` function to assert `type="button"`, `type="submit"`, and `type="reset"` respectively.
- [ ] **Step 3:** Change `Button` destructuring to `{ className, variant = "default", size = "default", type = "button", ...props }` and pass `type={type}` to `ButtonPrimitive`.
- [ ] **Step 4:** Inspect app variants/sizes for repeated visual overrides reported by consumer agents; add only names used by at least two callsites and update story coverage for each.

### Task 2: Top-Level Component Consumers

**Files:**
- Modify matching shared Button consumers directly under `client/src/components/*.tsx`.

**Interfaces:**
- Consumes: existing `variant` and `size` values from `buttonVariants`.
- Produces: behavior-equivalent top-level callsites without redundant `type="button"` or visual classes already represented by selected variant/size.

- [ ] **Step 1:** Remove `type="button"` from shared `<Button>` callsites only.
- [ ] **Step 2:** Remove redundant visual classes such as duplicated padding, height, radius, typography, and variant colors when existing `variant`/`size` already supplies them.
- [ ] **Step 3:** Retain layout classes (`w-*`, margin, placement, alignment), dynamic classes, and CSS-variable feature colors.
- [ ] **Step 4:** Report any visual pattern shared by two or more callsites that lacks a variant/size; do not invent a one-off API.

### Task 3: Analysis, AI, and Comparison Consumers

**Files:**
- Modify matching shared Button consumers under `client/src/components/ai/`, `client/src/components/analyse/`, and `client/src/components/comparison/`.

**Interfaces:** Same consumer contract as Task 2.

- [ ] **Step 1:** Remove redundant shared-Button `type="button"` props.
- [ ] **Step 2:** Replace duplicated visual classes with existing variants/sizes.
- [ ] **Step 3:** Keep state-dependent AI selection classes and feature-specific accents as `className`.
- [ ] **Step 4:** Report repeated missing visual contracts to Task 1.

### Task 4: Tune and Setup Consumers

**Files:**
- Modify matching shared Button consumers under `client/src/components/tune/`, `client/src/components/tunes/`, and `client/src/components/setup-tune/`.

**Interfaces:** Same consumer contract as Task 2.

- [ ] **Step 1:** Remove redundant shared-Button `type="button"` props.
- [ ] **Step 2:** Remove visual overrides represented by existing app variants/sizes.
- [ ] **Step 3:** Preserve menu-item width/alignment, sticky-layout placement, dynamic tab styles, and contextual status styling.
- [ ] **Step 4:** Report repeated missing visual contracts to Task 1.

### Task 5: Game, Settings, and Route Consumers

**Files:**
- Modify matching shared Button consumers under `client/src/components/ac-evo/`, `client/src/components/acc/`, `client/src/components/f1/`, `client/src/components/settings/`, `client/src/routes/`, and `client/src/components/track/`.

**Interfaces:** Same consumer contract as Task 2.

- [ ] **Step 1:** Remove redundant shared-Button `type="button"` props.
- [ ] **Step 2:** Use existing variants/sizes for reusable visual treatment.
- [ ] **Step 3:** Preserve form submit/reset types, dynamic active states, and layout-only classes.
- [ ] **Step 4:** Report repeated missing visual contracts to Task 1.

### Task 6: Remaining Consumer Audit

**Files:**
- Modify remaining matching shared Button consumers under `client/src` not owned by Tasks 2–5, including `assistant-ui/`, `driver/`, and shared UI wrappers.

**Interfaces:** Same consumer contract as Task 2.

- [ ] **Step 1:** Search remaining files for `<Button ... type="button"` and remove only redundant shared-Button defaults.
- [ ] **Step 2:** Audit `className` against visual-versus-layout contract; remove only redundant visual declarations.
- [ ] **Step 3:** Preserve wrapper-forwarded `className`, assistant-ui integration classes, explicit submit/reset semantics, and third-party render composition.
- [ ] **Step 4:** Report repeated missing visual contracts to Task 1.

## Integration Verification

Main agent performs after all six slices settle:

1. Review merged edits and resolve shared variant reports centrally.
2. Search `client/src` for remaining shared `<Button type="button">` usage and verify each exception.
3. Run focused Storybook interaction/snapshot path that exercises `UI/Reusable primitives / ButtonVariants`.
4. Run `cd client && bun run build`.
5. Run React Doctor over changed React files.
6. Commit implementation and push `reusable-ui-components-rescue` to `origin`, updating PR #198.
