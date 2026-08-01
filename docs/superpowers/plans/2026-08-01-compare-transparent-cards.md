# Compare Transparent Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every compare-page card transparent while preserving existing borders and layout.

**Architecture:** Keep card markup and component boundaries unchanged. Remove only gray `bg-app-surface-alt/*` utility classes from card wrappers in `CompareAiPanel.tsx`; retain all existing border utilities and other classes.

**Tech Stack:** React, TypeScript, Tailwind CSS v4 utilities, Biome, Vite.

## Global Constraints

- Modify only compare card backgrounds; do not change borders, layout, typography, buttons, or behavior.
- Scope changes to `client/src/components/comparison/CompareAiPanel.tsx`.
- Preserve existing card radius, padding, border opacity, and content.

---

### Task 1: Remove gray backgrounds from compare cards

**Files:**
- Modify: `client/src/components/comparison/CompareAiPanel.tsx:226,292,379,422`
- Test: `client/src/components/comparison/CompareAiPanel.tsx` via Biome and TypeScript build

**Interfaces:**
- Consumes: Existing card wrapper class strings in `InputsSection`, `LapSection`, segment rendering, and coaching rendering.
- Produces: Same compare card wrappers with transparent backgrounds and unchanged border utilities.

- [ ] **Step 1: Remove background utilities only**

  Update the four card wrapper class strings by deleting these background utilities:

  ```tsx
  bg-app-surface-alt/30
  bg-app-surface-alt/40
  ```

  Keep each wrapper's `rounded-*`, `border`, `border-app-border-input/40`, spacing, conditional hover classes, and child content unchanged.

- [ ] **Step 2: Verify class-level contract**

  Confirm `CompareAiPanel.tsx` has no `bg-app-surface-alt/*` utility on the four card wrappers and still contains `border-app-border-input/40` on each wrapper. Do not remove unrelated background utilities used by buttons, controls, or hover states.

- [ ] **Step 3: Run focused validation**

  Run from repository root:

  ```bash
  bun --cwd client run lint client/src/components/comparison/CompareAiPanel.tsx
  bun --cwd client run build
  ```

  Expected: Biome reports no issues for the changed component, and the client build completes successfully.

- [ ] **Step 4: Review visual result**

  Open compare page in the existing local client and inspect input, lap, segment, and coaching cards. Expected: card interiors inherit page background, borders remain visible, and no spacing/content changes appear.

- [ ] **Step 5: Commit implementation**

  ```bash
  git add client/src/components/comparison/CompareAiPanel.tsx
  git commit -m "style: make compare cards transparent"
  ```
