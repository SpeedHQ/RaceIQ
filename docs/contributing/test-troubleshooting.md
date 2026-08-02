# Troubleshooting test processes

Use this guide when Bun prints test results but does not exit, or when one test
file appears to run indefinitely.

## Establish the symptom

Run the project command first:

```sh
bun run test
```

If assertions complete but the process remains alive, a module probably left an
event-loop handle open. Common sources:

- database connections;
- referenced timers;
- UDP, HTTP, or WebSocket servers;
- child processes;
- imported modules that start services at module load.

The last file printed is not necessarily responsible. A handle opened by an
earlier file can keep the shared test process alive.

## Isolate the owner

Run files in isolated processes:

```sh
bun test --isolate
```

Then narrow to suspected files:

```sh
bun test test/suspect.test.ts
bun test test/suspect.test.ts test/dependent.test.ts
```

Pair testing is useful when the leak depends on import order or shared state.

For temporary local diagnosis, inspect active handles in teardown:

```ts
console.log(process._getActiveHandles?.());
console.log(process._getActiveRequests?.());
```

Remove this instrumentation after identifying the owner.

## Common fixes

- Pass fake adapters explicitly. Optional helper defaults often construct the
  production dependency.
- Close databases, sockets, servers, and child processes in teardown.
- Clear long-lived timers, or call `unref()` when a timer must not keep the
  process alive.
- Avoid module-level initialization that opens resources before the test can
  arrange teardown.
- Prefer isolated temporary databases and data directories.

## Historical example: default memory adapter

`test/chat-generations.test.ts` once omitted its fake memory argument. Helpers
fell back to the production memory store, which opened a live database
connection. The visible hang appeared in a later test file.

The contract-defending fix was to pass the dependency explicitly:

```ts
const generations = await listThreadGenerations("lap-42", fakeMemory);
await resolveActiveThread("lap-42", fakeMemory);
```

Use this pattern whenever a helper can resolve a production adapter by default.

## Distinguish leaks from failures

A failing assertion that returns control is not a hang. Diagnose current
failures from their output rather than maintaining a dated exception list in
documentation.
