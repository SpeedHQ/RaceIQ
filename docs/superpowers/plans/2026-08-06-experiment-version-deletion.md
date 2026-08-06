# Experiment Version Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore reversible version-node deletion and Trash/Restore recovery in the experiments version graph.

**Architecture:** Keep deletion semantics in existing server routes and client hooks. Add the missing controls and dialog to `VersionGraph.tsx`, using the existing query invalidation and soft-delete subtree behavior. Do not restore unrelated comparison UI.

**Tech Stack:** React, TypeScript, TanStack Query, existing `Dialog`/`Button` UI components, lucide-react, Bun tests, Playwright.

## Global Constraints

- Delete remains reversible soft deletion of the selected node and all descendants.
- Trash loads deleted versions lazily and restores selected subtree roots.
- Preserve checkout, setup, review, notes, and graph behavior.
- Do not add comparison UI or backend compatibility routes.

---

### Task 1: Restore deletion and Trash controls

**Files:**
- Modify: `client/src/components/tunes/experiment/VersionGraph.tsx`
- Use: `client/src/hooks/experiment-history.ts` (`useDeletedExperimentVersions`, `useDeleteVersion`, `useRestoreVersion`)

**Interfaces:**
- Consumes existing mutation/query hooks and `ExperimentVersion.parentVersionId`.
- Produces per-node Delete action plus graph-level Trash dialog.

- [ ] **Step 1: Add imports and local state**

Add `Trash2` from `lucide-react`, `Dialog`, `DialogContent`, `DialogHeader`, and `DialogTitle` from the existing UI dialog module, plus the three existing experiment-history hooks. Add `trashOpen` state and initialize delete/restore mutations and the deleted-version query enabled by `trashOpen`.

Use these exact hook calls:

```tsx
const deleteVersion = useDeleteVersion();
const restoreVersion = useRestoreVersion();
const { data: deletedTests = [], isLoading: loadingTrash, isError: trashError } = useDeletedExperimentVersions(sessionId, trashOpen);
```

- [ ] **Step 2: Add per-node delete action**

Place a destructive icon button beside the existing Notes action. Stop event propagation, confirm with `window.confirm`, mention the whole branch when `childrenOf.get(t.id)` is non-empty, then call:

```tsx
deleteVersion.mutate({ sessionId, versionId: t.id });
```

Set `disabled={deleteVersion.isPending}`, use `Trash2 aria-hidden="true"`, and provide an accessible label distinguishing `Delete version` from `Delete branch`. Keep confirmation cancellation side-effect free.

- [ ] **Step 3: Include delete/restore errors in the existing error banner**

Change the existing action error selection from only `setHead.error` to the first available of `setHead.error`, `deleteVersion.error`, and `restoreVersion.error`.

- [ ] **Step 4: Add Trash launcher and dialog**

Render a `Trash` button near the graph controls. When opened, render a dialog titled `Deleted branches` with:

- `Loading trash…` while loading;
- `Could not load deleted branches.` on query error;
- `Trash is empty.` for an empty successful result;
- only deleted roots, filtered by `parentVersionId == null` or absent deleted parent;
- one `Restore` button per root calling `restoreVersion.mutate({ sessionId, versionId: t.id })` and disabled while restore is pending;
- a `Close` button and `onOpenChange` close behavior.

Use the existing dialog conventions: `open`, `showCloseButton={false}`, `layout="scrollable"`, and `DialogHeader`/`DialogTitle`.

- [ ] **Step 5: Run focused type validation**

Run:

```bash
bun run typecheck
```

Expected: command exits 0 with no TypeScript errors.

- [ ] **Step 6: Commit implementation**

```bash
git add client/src/components/tunes/experiment/VersionGraph.tsx
git commit -m "feat(experiments): restore version deletion UI"
```

### Task 2: Verify deletion and recovery behavior

**Files:**
- Test: existing `test/experiments/drills/undo.test.ts`
- Test: existing `playwright/tests/seeded/experiments/disposable-lifecycle.spec.ts`

**Interfaces:**
- Consumes the restored UI and existing delete/restore routes.
- Produces evidence that active graph versions disappear after delete and return after restore.

- [ ] **Step 1: Run focused server deletion tests**

Run:

```bash
bun test test/experiments/drills/undo.test.ts --timeout 30000
```

Expected: all tests pass, including subtree deletion and undo restoration.

- [ ] **Step 2: Exercise the seeded experiment lifecycle path**

Run the existing targeted Playwright spec:

```bash
cd playwright && PW_SERVER_SET=seeded bunx playwright test tests/seeded/experiments/disposable-lifecycle.spec.ts --project=seeded-e2e
```

Expected: the deletion endpoint succeeds, deleted versions report `status: "deleted"`, and undo restores active versions.

- [ ] **Step 3: Run final client validation**

Run:

```bash
cd .. && bun run typecheck
```

Expected: command exits 0.

- [ ] **Step 4: Review diff for scope**

Confirm only the approved design is present: Delete button, Trash dialog, Restore actions, and related error/pending state. Confirm no comparison UI or unrelated server changes were added.
