# Settings Sidebar Navigation Design

## Goal

Make settings navigation a left sidebar on desktop-sized dialog views while using a burger menu on mobile.

## Current issue

`Settings.tsx` switches from horizontal navigation to a sidebar only at `@3xl/settings`. The settings dialog is capped at `max-w-2xl`, so its container cannot reach that breakpoint and desktop views incorrectly keep the navigation at the top.

## Design

- Widen the desktop settings dialog from `max-w-2xl` to `max-w-4xl`; keep mobile full-width behavior unchanged.
- Use a reachable container breakpoint for the desktop sidebar, targeting `@xl/settings`.
- Render the settings content beside a vertical left navigation sidebar at and above that breakpoint.
- Below the breakpoint, render a compact mobile header with:
  - a burger/menu button;
  - the active section label;
  - the existing settings content below.
- Opening the mobile menu reveals all available settings sections.
- Selecting a section updates the active section and closes the mobile menu.
- Keep developer-only filtering unchanged.
- Keep the Setup Wizard action available in the navigation; place it in the desktop sidebar footer and in the mobile menu.
- Preserve the existing `initialSection`, `onClose`, and section rendering behavior.

## Implementation boundaries

- Modify the existing settings navigation component and its existing dialog layout only as required.
- Do not change settings persistence, routing, or section APIs.
- Reuse existing Button variants, localization messages, and Tailwind app tokens.

## Verification

- Run the client build/typecheck.
- Exercise the settings dialog at desktop width and confirm the sidebar is on the left.
- Exercise it at mobile width and confirm the burger menu opens, selects sections, and closes after selection.
