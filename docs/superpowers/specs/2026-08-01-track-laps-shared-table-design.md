# Track Laps Shared Table Design

## Goal

Make Track Detail > Laps use the same shared table component primitives as session laps so spacing, typography, and sizing follow one contract.

## Scope

Update the desktop laps table in `client/src/components/track/TrackDetail.tsx` to use `Table`, `THead`, `TH`, `TBody`, `TRow`, and `TD` from `components/ui/AppTable`.

Preserve existing behavior:

- car, class, session type, lap, time, action, sector, date, and notes columns
- sorting controls
- lap selection and select-all
- analyse navigation
- fastest-lap styling
- valid/invalid indicators and invalid-lap tooltip
- mobile card layout

Do not change data fetching, filtering, or column visibility rules.

## Layout

Use shared table primitives and session-table spacing conventions. Keep the existing desktop stats/table split and horizontal overflow behavior. Avoid adding a second table styling system.

## Verification

Run the relevant TypeScript/build check and inspect the rendered Track Detail laps tab plus session laps view. Confirm both tables use shared primitives, all interactions remain available, and mobile cards are unchanged.
