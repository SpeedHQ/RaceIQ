# Sidebar Home Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RaceIQ titles navigate home and keep sidebar controls aligned right when titles are visible.

**Architecture:** Reuse TanStack Router `Link` already imported by `AppSidebar` and `__root`. Preserve existing flex headers and responsive behavior; only replace title text with links and add the alignment class needed for the mobile title.

**Tech Stack:** React, TanStack Router, Tailwind utility classes, existing app `Button` primitive.

## Global Constraints

- Preserve existing header height, borders, colors, typography, and responsive classes.
- Preserve close callbacks, collapse state, labels, and route behavior.
- Expanded headers place controls at right; collapsed desktop header centers icon.

---

### Task 1: Update sidebar and mobile header

**Files:**
- Modify: `client/src/components/AppSidebar.tsx:217-228`
- Modify: `client/src/routes/__root.tsx:256-260`

**Interfaces:**
- Consumes: existing `Link` import and `/` route.
- Produces: clickable `RaceIQ` home links in desktop expanded and mobile headers.

- [ ] **Step 1: Replace desktop title text with router link**

Use `Link to="/"` for the expanded desktop title, preserving `text-sm font-semibold text-app-text`; keep collapsed desktop title hidden.

- [ ] **Step 2: Keep desktop collapse action on header right**

Retain `justify-between px-3` for expanded desktop state and `justify-center` for collapsed state. Do not change mobile close behavior.

- [ ] **Step 3: Replace mobile title text with router link**

Use `Link to="/"` with the existing title classes. Keep mobile header `justify-between`, so title remains left and menu button remains right.

- [ ] **Step 4: Build and smoke-test**

Run the existing client production build command from `client/package.json`. Open the app and verify desktop expanded title click navigates `/`, desktop collapse control remains right aligned, collapsed icon remains centered, and mobile title click navigates `/` while close button remains right aligned.

- [ ] **Step 5: Commit implementation**

```bash
git add client/src/components/AppSidebar.tsx client/src/routes/__root.tsx
git commit -m "fix: link sidebar brand to home"
```
