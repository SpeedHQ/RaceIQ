# Session type badges

Replace visible session-type values with a shared single-letter badge across live dashboards, session lists, recent sessions, result summaries, and setup displays. Exception: the dashboard Session time widget uses full plain-text type labels with a doughnut chart matching Track time distribution, not badges or bars. Preserve recorded elapsed-time data, sorting, visibility rules, non-type metadata, loading/error/empty states, and timing coverage notes. Badge values use the first uppercase letter of the normalized type (P practice, Q qualifying, R race, etc.); unknown/unavailable types use U. Preserve the complete formatted type in title and accessible label, including numbered variants.

Implement shared SessionTypeBadge using existing Badge variants and theme tokens; colour-code practice/test day cyan, qualifying/shootout amber, race/sprint green, other known types cyan, unknown neutral. Migrate every display; verify representative desktop/mobile UI and typecheck; document change in changelog.

Acceptance: session-type values outside Session time use one-letter badges; Session time has that exact localized title, full type labels, and a doughnut with duration/percentage legend including Other. Full meaning remains accessible; no changes to stored types or behavior; affected UI renders without overflow.

ADR: [Session type badges](../adr/0009-session-type-badges.md)
