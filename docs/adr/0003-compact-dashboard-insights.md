# Compact dashboard insight row

Status: proposed

## Problem

Activity frequency and pace progress no longer match requested overview content. Podium counts must represent recorded racing achievements, not transient race positions.

## Decision

Keep compact overview row below global game cards with Clean laps and Podiums. Replace Practice rhythm and remove Pace progress, including obsolete calculations and props. Podiums use full session history and existing canonical result authority: confirmed finished own races only, counted once per session with first/second/third breakdown. Expose stored outcome status through existing session metadata rather than creating another fetching/aggregation path. Preserve game filtering, theme, localization, accessibility, and game-specific placement.

## Consequences

Two responsive columns replace three. Missing results, loading, and errors remain distinguishable from measured zero. Display records only available positions; no inferred class results. Existing clean-lap metric remains unchanged.

## Plan

[Requirements and verification](../plans/compact-dashboard-insights.md)
