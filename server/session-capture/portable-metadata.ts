import { z } from "zod";

const finite = z.number().finite();
const actorSchema = z.object({ gameId: z.enum(["acc", "ac-evo", "f1-2025", "fm-2023", "iracing", "lmu"]), source: z.string(), actorId: z.string(), bindingScope: z.enum(["session", "installation"]), sessionId: z.string(), clockDomain: z.string(), observedAtMs: finite, evidenceExpiresAtMs: finite.optional() }).strict();
export const stintSchema = z.object({ gameId: actorSchema.shape.gameId, source: z.string(), sessionId: z.string(), startMs: finite, endMs: finite.nullable(), evidenceValidUntilMs: finite,
  clockDomain: z.string(), actor: actorSchema.nullable(), attribution: z.enum(["Self", "Other", "Unknown"]), bindingRevision: z.number().int().positive().nullable(),
  bindingSnapshot: z.object({ id: z.string(), gameId: actorSchema.shape.gameId, sourceKind: z.string(), nativeIdentity: z.string(),
    confirmation: z.enum(["native_verified", "user_confirmed"]), revision: z.number().int().positive().safe() }).strict().optional(),
}).strict();
