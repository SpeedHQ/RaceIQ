# Responsive dashboard game-card grid

Status: proposed

## Problem

`GameBrandCards` starts with two columns even in narrow workspaces and changes to a six-item flex row at 768px workspace width. Long game names and metrics compete for insufficient space. Sidebar width makes viewport breakpoints unsuitable.

## Decision

Following updated user direction, use centered wrapping rows of content-sized cards at least 168px wide, including centered incomplete rows. Cards reserve 56px of height for enlarged logo imagery behind stacked metrics, with 8px padding. Both values and trailing labels are right-aligned; use translated Driving instead of Time. Share a `Card` gradient variant between game cards and Latest Session, using a subtle theme-accent radial gradient instead of duplicated blurred elements. Preserve normal-weight metrics, accessible names, routes, values, translations and hidden-game filtering. Bundle the official iRacing logo instead of its text abbreviation.

The previous one/two/three/six-column grid maintained balanced sets but expanded cards unnecessarily. Content-sized flex rows fit more cards without stretching and center partial rows naturally. A shared optional Card variant avoids duplicate gradient treatment without changing existing Card consumers or adding dependencies.

Overview cards render the bundled official logo artwork as original-colour images, rather than monochrome silhouettes. F1 and Forza assets define intrinsic red and white respectively so image rendering does not inherit an unrelated interface accent. Other logos retain their existing artwork colours. Scale logos proportionally across the card's inset area and fade their alpha toward the right-hand metrics; metrics remain on a separate foreground layer. Larger minimum cards improve recognition of wide wordmarks without distorting artwork. Sidebar and per-game header styling remain outside this refinement.

## Consequences

Narrow screens use more vertical space in exchange for readable cards. Logo-led identity avoids long-title wrapping; accessible names keep every destination identifiable without visible duplicate text. Existing theme tokens remain authoritative.

## Plan

[Requirements, implementation, and verification](../plans/responsive-game-cards.md)
