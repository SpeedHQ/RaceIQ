# TTS for AI Analysis — Design Spec

## Overview

Add text-to-speech narration to the AI analysis modal, allowing users to listen to analysis results like a race engineer debrief. Uses Microsoft Edge TTS (free neural voices) via a server-side endpoint.

## Architecture

### Server: `POST /api/tts`

Stateless endpoint that converts text to speech audio.

**Request:**
```json
{
  "text": "string — narration text",
  "voice": "string — Edge TTS voice ID, e.g. en-GB-RyanNeural"
}
```

**Response:** Binary MP3 audio (`Content-Type: audio/mpeg`)

**Implementation:**
- Uses `Bun.spawn` with an argument array (never a shell string) to invoke `edge-tts`: `["edge-tts", "--voice", voice, "--text", text, "--write-media", "-"]`
- Streams stdout directly as the response body — no temp files needed
- Validates voice ID against the curated voice allowlist before spawning (rejects unknown voices with 400)
- Max text length: 5000 characters (rejects with 400)
- Text is passed as a CLI argument via the array — no shell interpolation, no injection risk

**Dependency:** `edge-tts` Python package (`pip install edge-tts`). Requires Python 3.8+ on the server machine.

**Deployment:** Ensure Python 3.8+ and `edge-tts` are installed on the server machine. If Python is not available at runtime, the endpoint returns 503 with `{ error: "TTS not available — edge-tts not installed" }`.

### Client: `useTTS` Hook

Custom React hook managing playback state.

**State:**
- `playingSection: string | null` — ID of the currently playing section (e.g. "verdict", "pace", "corners")
- `loading: boolean` — true while fetching audio from server
- `audioRef` — internal ref to the current `Audio` element

**API:**
- `play(sectionId: string, text: string)` — stops any current playback, fetches audio from `/api/tts`, plays it
- `stop()` — stops current playback, clears state
- `isPlaying(sectionId: string): boolean` — true if this section is currently playing
- `isLoading: boolean` — true if audio is being fetched

**Behaviour:**
- Clicking play on a new section stops the previous one automatically
- When audio finishes naturally, `playingSection` resets to null
- Uses `URL.createObjectURL` on the MP3 blob for the Audio element
- Revokes the previous object URL before creating a new one (when switching sections)
- Cleans up any remaining object URL on unmount

## Narration Text Building

Each section type has a function that converts structured analysis data to natural spoken text.

| Section | Template |
|---------|----------|
| Verdict | Read as-is |
| Summary | Verdict + critical/warning pace items + critical/warning handling items + major corners |
| Pace | "{label} is {value}. {detail}" — joined with pauses |
| Handling | "{label} is {value}. {detail}" — joined with pauses |
| Corners | "{name}: {issue}. To fix this, {fix}" — per corner |
| Technique | "Tip {n}: {tip}. {detail}" — per item |
| Setup | "{change}. The symptom is {symptom}. The fix is {fix}" — per item |
| Tuning | "For {component}, {direction} to {target}. {reason}" — per item |

Text is joined with `. ` (period + space) to create natural pauses between items.

## UI Changes

### AiAnalysisModal

**Section headers:** Add a play/stop button as a sibling element next to `SectionHeader` (not inside it — `SectionHeader` stays a pure presentational component). Wrap both in a flex container. When the section is playing, show a stop icon instead of play. When loading, show a spinner.

**Footer:** Add a "Play Summary" button with a `Volume2` icon, positioned before the "Save Image" button. This plays the verdict + key findings narration.

**Active section highlight:** The currently playing section gets a `ring-1 ring-amber-400/30` CSS class applied to its container, providing subtle visual feedback.

**Stopping:** Clicking play on the currently playing section stops it. Clicking play on a different section stops the current and starts the new one. Closing the modal stops playback.

### Settings Page

**New "Voice" section** in the existing settings UI:
- Dropdown select with curated voice options
- Small "Preview" button next to the dropdown that plays a short sample phrase
- Persisted in the existing settings store/API

**Curated voices:**

| ID | Label |
|----|-------|
| `en-GB-RyanNeural` | Ryan (British male) — default |
| `en-GB-SoniaNeural` | Sonia (British female) |
| `en-US-GuyNeural` | Guy (American male) |
| `en-US-JennyNeural` | Jenny (American female) |
| `en-US-AriaNeural` | Aria (American female) |
| `en-AU-WilliamNeural` | William (Australian male) |
| `en-AU-NatashaNeural` | Natasha (Australian female) |
| `en-IE-ConnorNeural` | Connor (Irish male) |

### Settings Schema

Add to settings type and default:
```typescript
ttsVoice: string // default: "en-GB-RyanNeural"
```

This follows the existing pattern for settings (stored server-side, cached client-side via Zustand).

**Touch points for settings change:**
1. `server/settings.ts` — Add `ttsVoice` to `AppSettings` interface and `DEFAULT_SETTINGS`
2. `server/settings.ts` — Add `ttsVoice` to the field-by-field merge in `loadSettings()`
3. `server/routes.ts` — Add `ttsVoice` to the `PUT /api/settings` whitelist merge, with validation against the curated voice allowlist
4. Client uses existing `useSettings` / `useSaveSettings` hooks from `client/src/hooks/queries.ts` — no new fetch logic needed

## File Changes

| File | Change |
|------|--------|
| `server/routes.ts` | Add `POST /api/tts` endpoint + add `ttsVoice` to settings whitelist |
| `server/settings.ts` | Add `ttsVoice` to `AppSettings`, `DEFAULT_SETTINGS`, and `loadSettings()` merge |
| `client/src/hooks/useTTS.ts` | New file — TTS playback hook |
| `client/src/components/AiAnalysisModal.tsx` | Add play buttons (sibling to SectionHeader), summary button, active highlight, useTTS integration |
| `client/src/lib/tts-narration.ts` | New file — narration text builders |
| `client/src/components/Settings.tsx` | Add "Voice" section to `NAV_ITEMS` array + voice dropdown with preview button |

## Error Handling

- If `edge-tts` is not installed, the `/api/tts` endpoint returns 503 with a clear error message
- If TTS fails (network, bad voice ID), the client shows a brief toast/inline error and stops the loading state
- The play buttons are always visible — errors are handled gracefully, not by hiding functionality

## Not In Scope

- Caching generated audio (analysis text is already cached; TTS is fast enough)
- Pause/resume controls
- Playback speed control
- Offline TTS fallback
- Auto-play on analysis load
