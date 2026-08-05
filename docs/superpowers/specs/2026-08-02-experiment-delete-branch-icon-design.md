# Experiment Delete Branch Icon Design

## Goal

Replace the text `Delete branch` control in the experiments workspace version tree with a compact bin icon button.

## Scope

- Update `client/src/components/tunes/VersionGraph.tsx` only.
- Use the existing `Trash2` icon from `lucide-react`.
- Keep the existing `app-ghost` button treatment and danger hover styling.
- Add an accessible `aria-label` and retain the dynamic tooltip describing whether the version or its whole branch is trashed.
- Preserve click propagation prevention, pending-state disabling, confirmation copy, and `useDeleteVersion` mutation behavior.

## Interaction

Clicking the icon still opens the existing confirmation dialog. Cancel leaves the graph unchanged. Confirm invokes the same reversible trash mutation. The icon button remains disabled while deletion is pending.

## Verification

Run the relevant client checks and exercise the experiments workspace version tree to confirm the icon renders, tooltip/accessibility label is present, confirmation remains intact, and deletion behavior is unchanged.
