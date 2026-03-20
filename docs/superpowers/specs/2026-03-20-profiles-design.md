# Profiles Feature Design

**Date:** 2026-03-20
**Status:** Approved

## Overview

Introduce local driver profiles so multiple users can share the same app instance. When a user switches their active profile, all subsequently recorded laps are attributed to that profile. Lap browsing views filter to show only the active profile's laps.

## Data Layer

### New table: `profiles`

```sql
profiles(
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  created_at TEXT NOT NULL
  -- no UNIQUE constraint on name: local tool, duplicates are acceptable
)
```

### Migration

- Add `profile_id INTEGER REFERENCES profiles(id)` to `laps` table (nullable for backward compatibility)
- Create a default "Driver 1" profile on first migration
- Set all existing laps to the default profile's ID

### Settings

Extend the existing settings JSON file with `activeProfileId: number` pointing to the currently active profile.

---

## Backend API

### New endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/profiles` | List all profiles |
| POST | `/api/profiles` | Create a new profile `{ name }` |
| PATCH | `/api/profiles/:id` | Rename a profile `{ name }` |
| DELETE | `/api/profiles/:id` | Delete a profile (prevent if it's the only one) |

### Modified endpoints

- `PATCH /api/settings` — extended to accept `activeProfileId`; this is how profile switching is performed (client calls `PATCH /api/settings { activeProfileId }` on selection)
- All lap-listing endpoints (`/api/sessions`, `/api/laps`, `/api/tracks/:id/laps`, etc.) gain an optional `?profileId=` query param; the client always passes the active profile ID

### Lap detection

The lap detector reads `activeProfileId` from settings at the moment a lap is saved and stamps it on the lap record. No changes to the detection logic itself.

---

## UI

### Profile switcher (nav bar, top-right)

- Displays the active profile's initial (in a colored circle) + name
- Clicking opens a dropdown:
  - List of all profiles — click any to switch
  - "Add profile" entry — expands to an inline name input
  - Hover on a profile reveals rename / delete actions
  - Deleting the last profile is blocked

### Lap views (Analyse, Compare, Track Viewer)

- All lap listing views pass `?profileId=<activeProfileId>` when fetching laps
- Switching profile triggers a refetch, instantly updating what's visible
- No manual filter needed — the active profile IS the filter

---

## Key Constraints

- Profiles are local only — no networking, no cloud sync
- A profile is just a name — no settings, avatar, or preferences
- At least one profile must always exist (the app blocks deleting the last one)
- Existing laps are preserved and attributed to the default "Driver 1" profile
