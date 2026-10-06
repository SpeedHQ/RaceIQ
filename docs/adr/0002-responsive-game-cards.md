# Responsive dashboard game-card grid

Status: proposed

## Problem

`GameBrandCards` starts with two columns even in narrow workspaces and changes to a six-item flex row at 768px workspace width. Long game names and metrics compete for insufficient space. Sidebar width makes viewport breakpoints unsuitable.

## Decision

Use workspace container queries to progress through one, two, three, and six equal grid columns. Keep full game names, existing branding, values, routes, and hidden-game filtering. Compact cards with 10px padding, smaller logos, inline metric labels and values, and no reserved header height. Permit wrapping instead of clipping content.

A continuously auto-fitting grid was considered, but produces four- or five-column rows for six games. Explicit column counts keep complete sets balanced while still responding to the workspace, not the viewport. No new component API or dependency is required.

## Consequences

Narrow screens use more vertical space in exchange for readable cards. Reduced internal spacing keeps cards compact at every width. Hidden games still leave ordinary partial grid rows. Existing theme styling remains authoritative.

## Plan

[Requirements, implementation, and verification](../plans/responsive-game-cards.md)
