/**
 * Shared visual-regression policy.
 *
 * Playwright and the PR preview collector must use the same pixelmatch
 * threshold and aggregate changed-pixel allowance. Keeping these values in
 * one module prevents the required check and advisory preview from disagreeing
 * about whether a screenshot contains a material change.
 */
export const VISUAL_DIFF_COLOR_THRESHOLD = 0.2;
export const VISUAL_DIFF_MAX_PIXEL_RATIO = 0.01;
