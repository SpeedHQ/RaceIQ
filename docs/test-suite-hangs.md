# Test Suite Hangs

Guide to diagnosing `bun test` never exiting.

## Symptom

Full suite runs all tests, prints results, then hangs forever. Or a single file
appears "stuck running" and never reports. CPU may spin at 100% on one core.

Tests **pass**. Process just refuses to exit.

## Cause

Bun exits when the event loop drains. Any live handle keeps it alive:

- open DB connection (LibSQL / DuckDB / SQLite)
- `setInterval` / `setTimeout` not `unref()`d
- open UDP or WebSocket socket
- spawned child process never killed

Hang is almost never in the test that *looks* stuck. Bun runs files in one
process by default — a leaked handle from file A blocks exit long after file A
finished, and the runner reports whichever file was last.

## Real case: 2026-04 chat-generations leak

`test/chat-generations.test.ts` called memory helpers without the fake adapter:

```ts
// leaks — falls through to real Mastra memory store, opens live LibSQL conn
const gens = await listThreadGenerations("lap-42");
await resolveActiveThread("lap-42");
```

`listThreadGenerations` / `resolveActiveThread` take an optional memory
argument. Omitted, they resolve the real store. Fix — pass the fake:

```ts
const gens = await listThreadGenerations("lap-42", fakeMemory);
await resolveActiveThread("lap-42", fakeMemory);
```

Full suite went from hanging indefinitely to 16.6s.

Symptom was misleading: `test/laps-issues-route.test.ts` was the file that
looked stuck. It was innocent — just ran after the leaker.

## Diagnosing

### 1. Confirm it is a leak, not a slow test

```powershell
bun test 2>&1 | Select-Object -Last 5
```

Results print but prompt never returns => leaked handle.

### 2. Bisect by file

Run halves until the hang follows a subset. Isolation mode gives one process
per file, so a hang pins to its real owner:

```powershell
bun test --isolate
```

Slower, but the hanging file is the guilty file. Good first move — often skips
the whole bisect.

### 3. Pair-test suspects

Leak only shows with a specific ordering. Test candidate against the file that
appeared stuck:

```powershell
bun test test/suspect.test.ts test/looked-stuck.test.ts
```

### 4. Inspect live handles

```ts
// in an afterAll
console.log(process._getActiveHandles?.());
console.log(process._getActiveRequests?.());
```

## Preventing

- Always pass fakes/mocks explicitly. Do not rely on a helper's default
  argument — defaults usually resolve the *real* dependency.
- `unref()` every long-lived timer in shared modules. A module-scope
  `setInterval` in `shared/` keeps every suite importing it alive.
- Add `afterAll` teardown that closes DBs, sockets, servers.
- Prefer in-memory DB for tests.
- Avoid top-level `await` in modules that open connections — it runs at import
  time, before any test can arrange teardown.

## Known unrelated failures

Do not chase these while hunting a hang. Pre-existing as of 2026-04:

- 6x track/corner data assertions — `laguna-seca`, `road-atlanta`, `sebring`
  centerline alignment; imola/brands-hatch detector-gap and meta-segment
  checks. `ac-evo` track definition data mismatches.
- `test/e2e/udp-recording.test.ts` — fails in isolation. Missing
  `discovered_cars` table, server exits 1 before ready.
