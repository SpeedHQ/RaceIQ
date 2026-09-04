/** Environment utilities. */
export const IS_DEV = process.env.NODE_ENV !== "production";
export const IS_E2E = process.env.RACEIQ_E2E === "1";
