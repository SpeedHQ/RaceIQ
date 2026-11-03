export function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Normalize URL-parser numbers while preserving canonical string identity keys verbatim. */
export function parseOptionalIdentityKey(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  // TanStack's default search parser decodes native venue/layout keys as JSON.
  if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string" && part.length > 0)) return JSON.stringify(value);
  return typeof value === "string" && value !== "" ? value : undefined;
}
