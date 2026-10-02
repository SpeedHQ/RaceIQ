/**
 * Known iRacing SessionInfo YAML leaves.
 *
 * iRacing does not publish a permanently closed YAML schema. This list covers
 * documented core sections plus stable CarSetup leaves observed in committed
 * captures. Generator validation checks every captured leaf against an exact
 * entry or the explicit fallback for genuinely car/build-specific setup data.
 */
export type IRacingSessionInfoRetention =
  | "exact"
  | "normalized"
  | "not-recorded";

export interface IRacingSessionInfoCatalogField {
  path: string;
  label: string;
  unit: string;
  description: string;
  retention: IRacingSessionInfoRetention;
  semanticId?: string;
}

export const IRACING_SESSION_INFO_RAW_SOURCE: IRacingSessionInfoCatalogField = {
  path: "SessionInfo",
  label: "Complete SessionInfo YAML",
  unit: "structured",
  description:
    "Complete raw iRacing SessionInfo YAML text preserved verbatim by source-frame v3.",
  semanticId: "diagnostics.raw-session-metadata",
  retention: "exact",
};
