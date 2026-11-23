### Breaking
- Download and install the Race Engineer voice pack separately; voice audio is no longer included with the app. Text callouts remain available without the pack.

### Features
- Install the optional Live Engineer voice package during setup or manage installed, required, and available versions in Settings → Live Engineer. Check compatible updates automatically when Radio audio is enabled, with an update prompt and retryable installation that preserves existing audio.
- Show download or update requirements in Radio before enabling voice audio, with independently versioned voice packs and explicit engine/catalog/language compatibility.
- Use Race Engineer naming throughout internal subsystem identifiers, paths, and user-facing labels.
- Announce source-backed component damage and faults: named F1 25 components and engine failures, ACC/AC Evo bodywork, iRacing native warnings and repair requirements, and LMU flat tyres/detached wheels. Preserve three-second debounce, independent escalation, and repair rearming; exclude wear and inferred diagnoses.
- Replace vague damage audio with 56 matching Qwen component/fault clips. LMU enablement remains damage-only; Forza damage stays unavailable.
- Add source-backed race engineer announcements for ACC and AC Evo, plus position changes for Forza Motorsport. Replay distinguishes unsupported systems from telemetry missing in older recordings.
- Inspect replayed engineer audio in a moving 10-second DAW timeline with individual, duration-scaled clip waveforms and inserted pauses.
- Choose a 50–100 Hz recording frequency for ACC, AC Evo, iRacing, or LMU during setup to reduce recording size. Live UDP recording is unchanged.
- Downsample saved recordings manually or with an opt-in age policy in Storage settings; measure the first 1,000 frame timestamps per stream and skip recordings already at or below the target. Track progress and retry failed files. Favorites and MoTeC imports stay unchanged.
- Split recordings into individual, lossless per-lap `.bin` files so lap 60 loads as fast as lap 1.

### Fixes
- Open a multi-lap recording for each of the seven games in Engineer Replay without importing a session first.
- Preserve live radio deadlines, paired spotter warnings and pace text. Correct iRacing flag calls, ACC class comparisons and recorded replay timing. Retry failed audio loads, reuse decoded clips and allow damaged voice packs to be repaired.
- Restore Race Engineer voice playback through the development dashboard proxy. Speech previews use generated source assets without replacing installed voice packs.
- Keep native recording write/close/replay working on Windows without calling unsupported directory `fsync`; preserve file flushes, POSIX directory syncing, and genuine filesystem errors.
- Keep recording layout migration progress polling from racing atomic journal replacement on Windows; preserve collision checks and resumable cutover.
- Keep ACC laps readable and exportable when recordings include opponent data, and hide stale opponent standings until the source recovers.
- Restore source-backed iRacing opponent pace announcements for sparse grids.
- Recognize F1 25 race sessions correctly when evaluating opponent pace.
- Keep ACC tyre-temperature warnings suppressed during warm-up, pit visits, and earlier sectors.
- Keep Engineer Replay focused on the actual player, preserve source-loss history, and stop queued audio after mute, seek, or session changes.
- Chain completed-lap time and pace announcements with a natural pause and without repeating "Your lap was."

### Internal
- Preserve race-engineer announcements, ACC Broadcast capture metadata, and replay/export behavior across the workspace and string-identity migrations.
