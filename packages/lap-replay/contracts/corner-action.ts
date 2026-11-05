import { z } from "zod";

/**
 * Corner actions are the single contract between AI output, chat rendering and
 * replay focus. The model names a corner and a playback target only; every
 * boundary is resolved from loaded telemetry by the client.
 *
 * See SpeedHQ/RaceIQ#515.
 */

export const CORNER_ACTION_TARGETS = ["solo", "A", "B", "linked"] as const;
export type CornerActionTarget = (typeof CORNER_ACTION_TARGETS)[number];

/** Hard cap so a runaway response cannot flood the renderer. */
export const MAX_CORNER_ACTIONS = 20;

const SpanSchema = z
  .object({
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  })
  .refine((span) => span.end > span.start, { message: "span.end must exceed span.start" });

export const CornerActionSchema = z.object({
  /** Stable per response; used to discard stale actions. */
  id: z.string().min(1).max(64),
  /** Canonical turn key from the track roster, never a free-form label. */
  cornerKey: z.string().min(1).max(160),
  /** Display text; canonical name when roster metadata exists. */
  label: z.string().min(1).max(80),
  target: z.enum(CORNER_ACTION_TARGETS),
  /** Character range within the normalized response text. */
  span: SpanSchema,
});

export type CornerAction = z.infer<typeof CornerActionSchema>;

export const CornerActionsSchema = z.array(CornerActionSchema).max(MAX_CORNER_ACTIONS);

/**
 * Validate a model response. Invalid entries are dropped individually so the
 * surrounding prose stays readable (issue acceptance: ordinary text remains).
 */
export function parseCornerActions(value: unknown): CornerAction[] {
  if (!Array.isArray(value)) return [];
  const actions: CornerAction[] = [];
  for (const raw of value.slice(0, MAX_CORNER_ACTIONS)) {
    const parsed = CornerActionSchema.safeParse(raw);
    if (parsed.success) actions.push(parsed.data);
  }
  return actions;
}

export type CornerActionSpanPart =
  | { kind: "text"; text: string }
  | { kind: "action"; action: CornerAction };

/**
 * Split response text around validated actions. Actions outside the text or
 * overlapping an earlier action are skipped, never rendered.
 */
export function splitCornerActionSpans(
  text: string,
  actions: readonly CornerAction[],
): CornerActionSpanPart[] {
  const usable = actions
    .filter((action) => action.span.start < text.length && action.span.end <= text.length)
    .sort((a, b) => a.span.start - b.span.start);

  const parts: CornerActionSpanPart[] = [];
  let cursor = 0;
  for (const action of usable) {
    if (action.span.start < cursor) continue;
    if (action.span.start > cursor) {
      parts.push({ kind: "text", text: text.slice(cursor, action.span.start) });
    }
    parts.push({ kind: "action", action });
    cursor = action.span.end;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}

/** A turn as the roster describes it. `key` is the canonical identity. */
export type TurnIdentity = {
  key: string;
  number: number;
  name?: string;
  aliases?: readonly string[];
};

export function normalizeTurnToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.。]+$/, "");
}

function candidatesFor(turn: TurnIdentity): string[] {
  const raw = [turn.key, `t${turn.number}`, `turn ${turn.number}`, turn.name, ...(turn.aliases ?? [])];
  return raw.filter((value): value is string => typeof value === "string" && value.length > 0).map(normalizeTurnToken);
}

/** Exact canonical lookup. Unknown or ambiguous keys resolve to null. */
export function resolveCornerKey(cornerKey: string, turns: readonly TurnIdentity[]): TurnIdentity | null {
  const key = normalizeTurnToken(cornerKey);
  if (key.length === 0) return null;
  const matches = turns.filter((turn) => normalizeTurnToken(turn.key) === key);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve a human reference such as `T1`, `Turn 10` or a corner name.
 * Exact tokens only: `T1` must never match `T10`.
 */
export function resolveTurnReference(reference: string, turns: readonly TurnIdentity[]): TurnIdentity | null {
  const token = normalizeTurnToken(reference);
  if (token.length === 0) return null;
  const matches = turns.filter((turn) => candidatesFor(turn).includes(token));
  return matches.length === 1 ? matches[0] : null;
}
