/**
 * Re-export the shared corner-action contract. The schema lives in
 * `@raceiq/shared` so server prompts, output schemas and client rendering all
 * validate against one definition (Issue #515).
 */
export * from "@raceiq/shared/integrations/ai/corner-action";
