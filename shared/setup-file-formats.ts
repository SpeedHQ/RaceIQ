import { z } from "zod";

/**
 * Which setup file format each game's Setup Engineer (experiments) flow accepts.
 *
 * Single source of truth for the drop zone, the `<input accept>` attribute and
 * the server's `place-setup` validation, so a file the UI lets through can never
 * be one the route then rejects (or worse, writes into the wrong game's Setups
 * folder).
 *
 * The formats are NOT interchangeable:
 *  - ACC saves setups as nested JSON (`carName` + `basicSetup`/`advancedSetup`).
 *  - AC EVO saves `.carsetup`, protobuf wire format with no shipped schema; it
 *    must round-trip byte-for-byte because `carsetup-writer.ts` patches it by
 *    byte offset (see test/place-setup-carsetup.test.ts).
 *
 * So an experiment page only offers its own game's format rather than accepting
 * both and guessing.
 */

export type SetupGameId = "acc" | "ac-evo";

export interface SetupFileFormat {
  /** The only accepted extension, lowercase, leading dot. */
  extension: string;
  /** Value for an `<input type="file" accept>`. */
  accept: string;
  /** How the payload travels to `place-setup`. */
  payload: "json" | "binary";
  /** Game name for user-facing copy. */
  gameLabel: string;
}

export const SETUP_FILE_FORMATS = {
  acc: {
    extension: ".json",
    accept: ".json,application/json",
    payload: "json",
    gameLabel: "Assetto Corsa Competizione",
  },
  "ac-evo": {
    extension: ".carsetup",
    accept: ".carsetup",
    payload: "binary",
    gameLabel: "Assetto Corsa EVO",
  },
} as const satisfies Record<SetupGameId, SetupFileFormat>;

export const SetupGameIdSchema = z.enum(["acc", "ac-evo"]);

export function setupFileFormat(gameId: SetupGameId): SetupFileFormat {
  return SETUP_FILE_FORMATS[gameId];
}

/** True when `fileName` carries the extension this game's setups use. */
export function isSetupFileNameForGame(gameId: SetupGameId, fileName: string): boolean {
  return fileName.toLowerCase().endsWith(SETUP_FILE_FORMATS[gameId].extension);
}

/** User-facing reason a dropped file was refused, or null when it's accepted. */
export function setupFileRejectReason(gameId: SetupGameId, fileName: string): string | null {
  if (isSetupFileNameForGame(gameId, fileName)) return null;
  const fmt = SETUP_FILE_FORMATS[gameId];
  const other = (Object.keys(SETUP_FILE_FORMATS) as SetupGameId[]).find((g) => g !== gameId && isSetupFileNameForGame(g, fileName));
  if (other) {
    return `${SETUP_FILE_FORMATS[other].extension} is a ${SETUP_FILE_FORMATS[other].gameLabel} setup — ${fmt.gameLabel} experiments take a ${fmt.extension} file.`;
  }
  return `Pick a ${fmt.extension} setup file (${fmt.gameLabel}).`;
}

/**
 * Shape gate for a dropped ACC setup JSON.
 *
 * Deliberately loose: it pins the two keys every Kunos setup has (`carName` and
 * `basicSetup`) and lets everything else through untouched, because the setup
 * body is a large nested click-value tree that varies by car and game version —
 * validating it field by field would reject valid setups after any game update.
 * The point is only to catch a JSON file that isn't a setup at all (a lap
 * export, a tune catalog entry, a random config).
 */
export const AccSetupJsonSchema = z.looseObject({
  carName: z.string().min(1),
  basicSetup: z.looseObject({}),
  advancedSetup: z.looseObject({}).optional(),
});

export type AccSetupJson = z.infer<typeof AccSetupJsonSchema>;
