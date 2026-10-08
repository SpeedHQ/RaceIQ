# Full-width recent sessions

Status: proposed

## Context

Latest Session sidebar takes width from Recent Sessions. User requests reduced recap presentation, full-width table, and session type.

## Decision

Use a full-width Overview with a compact latest-session summary immediately below global game cards. Keep the per-game section order. Remove the dashboard lap-time trend while retaining session-type bars. Omit the track map on Overview through the existing recap option, retaining standalone detail and recap actions. Reuse existing session type formatting.

Refine the arrangement with a compact full-width period-total strip and a shared desktop row for insights and activity. Size insight panels to content, stacking Podiums above Track stats in the middle column of wide insight containers. Reserve a bounded activity column only when the workspace can accommodate both groups. This replaces fixed-height insight panels and the sparsely populated calendar/statistics row without removing information or reducing chart readability.

Use stretch alignment within the content-sized insight grid: paired compact metrics and paired charts share row heights, while Track time distribution fills both rows on wide containers. Flex wrappers propagate the grid height to their panels. This removes ragged card edges without restoring fixed heights, clipping content, or forcing mobile cards to desktop dimensions.

## Rationale

A wide table improves scanning of track, car, and type without sacrificing space to a tall recap sidebar. Existing recap and formatter APIs avoid a second presentation convention.

## Plan

[Requirements and verification](../plans/full-width-recent-sessions.md)
