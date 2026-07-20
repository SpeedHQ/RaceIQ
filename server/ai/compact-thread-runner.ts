/**
 * Thin re-export seam so the compact route can be unit-tested without a global
 * module mock bleeding into `compact-thread.test.ts`.
 *
 * `mock.module` in bun is process-global and is applied at module-graph
 * evaluation (before any test runs), so mocking `./compact-thread` directly in
 * the route test also replaces it for every other test file that imports it —
 * dropping exports like `MIN_COMPACT_MESSAGES`. The route imports `compactThread`
 * through this runner instead, and the route test mocks THIS module; the real
 * `compact-thread.ts` unit tests import the source directly and stay unaffected.
 *
 * `NothingToCompactError` is re-exported (not re-declared) so the route's
 * `err instanceof NothingToCompactError` check sees the same class the helper
 * throws.
 */
export { compactThread, NothingToCompactError } from "./compact-thread";
