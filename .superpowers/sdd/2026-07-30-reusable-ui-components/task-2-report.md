# Task 2 — Dialog shell consolidation report

## Scope

Migrated all modal callsites listed in the reusable UI component plan to the existing Base UI Dialog composition. Added typed, feature-neutral `DialogContent` sizes (`default`, `sm`, `md`, `lg`, `wide`) using app surface/border/shadow, max-height, and overflow tokens. Updated the Dialog story to exercise `size="sm"`.

## Behavior inventory and preservation

| Callsite | Trigger/state ownership | Close behavior | Focus / scroll | Size and semantics | Tabs / header actions |
| --- | --- | --- | --- | --- | --- |
| `ui/NoteModal.tsx` | Caller owns mount state; migrated root is controlled-open while mounted | Existing backdrop, Escape, Cancel, Save preserved through `onOpenChange` plus existing handlers | Existing textarea mount focus retained; small dialog, no meaningful outer scroll | Existing ~480px shell mapped to `sm`; localized title remains `DialogTitle` | No tabs; actions moved to `DialogFooter` |
| `SessionRecapModal.tsx` | Caller owns mount state; controlled-open | Existing backdrop close retained; Dialog Escape/close behavior added by shared primitive | `Dialog` focus management; `md` max-height/scroll preserves 560px/85vh shell | Localized `recap_latest_session` hidden `DialogTitle`; `md` size | No custom actions |
| `analyse/ImportResultModal.tsx` | Caller owns mount state; controlled-open | Existing backdrop, Close, and Go-to-session handlers retained; Dialog Escape added | Dialog focus management; inner lap list remains max-height/scroll container | Existing ~480px shell mapped to `sm`; localized title/description structure retained | Footer actions use existing localized labels |
| `analyse/IbtImportPreviewModal.tsx` | Caller owns mount state; controlled-open | Existing action buttons retained; shared Dialog handles Escape/backdrop | Dialog focus management; content remains compact | Existing ~520px shell mapped to `md`; title/filename are `DialogHeader` content | Footer actions preserve Import/Cancel/Close behavior |
| `analyse/analysis-summary.tsx` (`AnalysisModalShell`) | Summary row caller owns mount state; controlled-open | Existing backdrop/custom close retained; Dialog Escape added | Shared focus management; body remains `flex-1 overflow-y-auto`, max 85vh | Existing 640px/85vh shell mapped to `lg`; hidden semantic title added | Existing analysis/setup tabs and subtitle remain in `DialogHeader` |
| `analyse/MotecImportModal.tsx` | Caller owns mount state; controlled-open | Existing backdrop and Cancel/Done handlers retained; shared Escape/backdrop | Existing max-height/overflow retained; Dialog focus management | Existing max-xl/85vh shell mapped to `lg` with callsite max-width override | `DialogHeader` contains Import MoTeC title; form/result controls unchanged |
| `comparison/CompareAiPanel.tsx` (`InputsModal`) | Panel owns `viewing`; controlled-open while inputs view exists | Existing backdrop/custom close retained; Dialog Escape added | Existing scroll body retained; max 85vh | Existing 720px/85vh shell mapped to `wide` | Header title and close action moved into `DialogHeader` |
| `tunes/AddBaseModal.tsx` | Caller owns mount state; controlled-open | Existing backdrop, panel Escape, Cancel, and submit-close behavior retained through Dialog/handlers | Dialog focus management; shared max-height prevents viewport overflow | Existing 680px shell mapped to `lg` with max-width override | Title/description in `DialogHeader`; actions in `DialogFooter` |
| `tunes/ImportLapsModal.tsx` | Caller owns mount state; controlled-open | Existing backdrop, panel Escape, Cancel, and submit-close behavior retained | Existing lap list scroll container retained; shared max-height | Existing 720px/86vh shell mapped to `wide` with max-height override | Title/description in `DialogHeader`; actions in `DialogFooter` |
| `tunes/HistoryPanel.tsx` | Caller owns mount state; controlled-open | Existing backdrop, panel Escape, and close behavior retained | Existing history scroll behavior retained with explicit bounded list area | Existing 520px/80vh shell mapped to `md` | Title in `DialogHeader`; Undo action remains adjacent content |
| `tunes/VersionGraph.tsx` (`NotesModal`) | Version graph owns selected note version; controlled-open | Existing backdrop, panel Escape, and close behavior retained | Existing 90vh overflow retained; Dialog focus management | Existing 820px/90vh shell mapped to `wide` | Title in `DialogHeader`; two-column driver/engineer content unchanged |
| `routes/__root.tsx` (`ReprocessProgressModal`) | Telemetry store owns progress; controlled-open | Completion-only close preserved: `onOpenChange` ignores close requests while processing; explicit close remains completion-only | Dialog focus management; compact fixed-size progress content | Existing `w-96` shell mapped to `sm` with width override | Progress title/icon and completion close action in `DialogHeader` |

Removed all duplicate `createPortal`/fixed backdrop/panel markup from these migrated callsites. Unlisted overlays and feature-specific shells were left unchanged.

## Focused verification

1. `cd client && bun run build`
   - Initial run exposed missing `m` import in `comparison/CompareAiPanel.tsx`; restored existing localized message import.
   - Final run: exit 0; Paraglide compile succeeded; TypeScript build succeeded; Vite transformed 5,620 modules and completed production build.
   - Vite emitted existing large-chunk warning only.
2. `cd client && bun run build-storybook`
   - Exit 0; Storybook build completed successfully.
3. `git diff --check`
   - Exit 0; no whitespace errors.

The known full-suite timeout and `test/story-isolation.test.ts` `@/paraglide/messages` resolution issue were not broadened or changed.
