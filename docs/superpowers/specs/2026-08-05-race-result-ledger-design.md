# Race Result Ledger Design

## Goal

Show a full chronological race-result ledger inside expanded session rows, with start, pit-event, and finish nodes connected horizontally.

## User experience

Expanding a session keeps the existing lap table and adds a `Race timeline` section above it. The section contains:

- Start node at the left.
- One node per persisted pit event, ordered by event sequence.
- Finish node at the right, showing classification and finishing or qualifying position.
- Connector line between nodes to make chronology explicit.

Pit nodes show lap number, service type, duration, tyre change, and fuel added when available. Missing values are omitted rather than rendered as zero. A session with no pit events still shows Start → Finish. Loading, request failure, and unavailable-result states are explicit and contained within the expanded section. The ledger scrolls horizontally on narrow screens rather than compressing node content.

## Data flow

The client fetches `/api/sessions/:id/result?gameId=...` only when an expanded row is rendered. The existing result endpoint already returns persisted result metadata and pit events; no server schema or route changes are required. React Query caches and deduplicates the request between mobile and desktop render trees.

A new `useSessionResult` query helper owns request/error typing. A focused `RaceResultLedger` component converts the result into display nodes and renders the horizontal timeline. `SessionsPage` mounts the component in both mobile-card and desktop-table expanded sections, passing `enabled` from the row's expanded state.

## States and edge cases

- No result yet: show a quiet unavailable state; do not trigger a new write from the client.
- Result with zero events: render Start → Finish.
- Unknown/unsupported classification: show `Unknown`.
- Null lap, duration, fuel, or tyre values: omit that detail.
- Long ledgers: horizontal overflow remains within expanded content.
- Existing lap selection, sorting, note editing, recap, and export interactions remain unchanged.

## Testing and verification

- Query helper test covers disabled behavior/request URL and successful result parsing using existing client query conventions.
- Component test or deterministic rendering test covers Start → pit → Finish ordering, empty events, and null optional fields.
- Existing client typecheck/build and targeted test suite must pass.
- Browser verification confirms expanded desktop and narrow/mobile rows show the ledger without breaking lap table interactions.
