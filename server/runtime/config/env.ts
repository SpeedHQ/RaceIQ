/** Environment utilities. */

export const IS_DEV = process.env.NODE_ENV !== "production";

/** Explicit harness gate for fixture-backed browser tests against compiled builds. */
export const IS_E2E = process.env.RACEIQ_E2E === "1";
