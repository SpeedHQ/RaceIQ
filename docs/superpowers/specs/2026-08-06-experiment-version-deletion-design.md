# Experiment Version Deletion Design

## Goal

Restore version-node deletion in the experiments version graph, including recovery through the existing Trash workflow.

## Existing behavior

The server already provides reversible soft deletion for a version and its descendant subtree at `POST /api/experiments/:id/versions/:versionId/delete`, plus subtree restoration at the corresponding `restore` route. Client hooks in `client/src/hooks/experiment-history.ts` already wrap both routes and invalidate experiment, version, and chat queries.

## UI changes

Update `client/src/components/tunes/experiment/VersionGraph.tsx` only for this feature:

- Add a destructive per-node delete button using the existing `useDeleteVersion` hook.
- Confirm deletion with the node label and indicate when descendants will also be deleted.
- Disable deletion while the mutation is pending and surface mutation errors alongside existing checkout errors.
- Add a Trash control and dialog using `useDeletedExperimentVersions` and `useRestoreVersion`.
- Show only deleted subtree roots in Trash; restore a selected root and its descendants.
- Handle loading, load failure, empty trash, restore pending state, and close behavior.

Do not restore unrelated version-comparison UI from the historical implementation. Preserve checkout, setup, review, notes, graph rendering, and existing soft-delete semantics.

## Verification

Run focused experiment deletion/undo tests and the client validation/build command used by the repository. Verify the changed graph path end to end: delete a version branch, confirm it disappears from the active graph, open Trash, restore it, and confirm it returns.
