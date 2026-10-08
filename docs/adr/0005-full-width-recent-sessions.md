# Full-width recent sessions

Status: proposed

## Context

Latest Session sidebar takes width from Recent Sessions. User requests reduced recap presentation, full-width table, and session type.

## Decision

Use a full-width Overview with a compact latest-session summary immediately below global game cards. Group activity and summary statistics in a responsive row, tighten spacing and desktop insight height, and remove the dashboard lap-time trend while retaining session-type bars. Keep the per-game section order. Omit the track map on Overview through the existing recap option, retaining standalone detail and recap actions. Reuse existing session type formatting.

## Rationale

A wide table improves scanning of track, car, and type without sacrificing space to a tall recap sidebar. Existing recap and formatter APIs avoid a second presentation convention.

## Plan

[Requirements and verification](../plans/full-width-recent-sessions.md)
