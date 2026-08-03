import { z } from "zod";
export const KNOWN_GAME_IDS = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"] as const;

export const GameIdSchema = z.enum(KNOWN_GAME_IDS);

export type GameId = z.infer<typeof GameIdSchema>;
