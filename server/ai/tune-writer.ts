/**
 * writeSetupFile — pass 4 of the auto-tune pipeline.
 *
 * Serialises an applied setup object back to a `.json` file on disk. The
 * target lives next to the source setup (same car/track folder) with a
 * `-autotune` suffix so the original is never overwritten. Path safety is
 * enforced the same way as the import-file route: the resolved destination
 * must live inside the caller-supplied setups base dir.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { dirname, resolve, sep } from "path";

export interface WriteSetupResult {
  path: string;
  fileName: string;
}

/**
 * Write `setup` as pretty JSON to a sibling of `sourcePath` named
 * `<stem>-autotune.json` (auto-incrementing to `-autotune-2`, etc. so repeated
 * runs never clobber). `baseDir` is the setups root the destination must stay
 * inside; a symlink can't escape it.
 */
export function writeSetupFile(
  baseDir: string,
  sourcePath: string,
  setup: unknown,
): WriteSetupResult {
  const absSource = resolve(sourcePath);
  const dir = dirname(absSource);

  // Guard: destination directory must resolve inside the setups base dir.
  const realBase = realpathSync(resolve(baseDir));
  const realDir = existsSync(dir) ? realpathSync(dir) : dir;
  if (!(realDir + sep).startsWith(realBase + sep) && realDir !== realBase) {
    throw new Error("Destination is outside the Setups folder");
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const stem = (absSource.split(/[\\/]/).pop() ?? "setup").replace(/\.json$/i, "");
  let dest = resolve(dir, `${stem}-autotune.json`);
  let n = 2;
  while (existsSync(dest)) {
    dest = resolve(dir, `${stem}-autotune-${n}.json`);
    n++;
  }

  writeFileSync(dest, JSON.stringify(setup, null, 2), "utf-8");
  return { path: dest, fileName: dest.split(/[\\/]/).pop() ?? "" };
}
