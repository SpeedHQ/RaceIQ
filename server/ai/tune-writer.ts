/**
 * writeSetupFile — pass 4 of the auto-tune pipeline.
 *
 * Serialises an applied setup object back to a `.json` file on disk. The
 * target lives next to the source setup (same car/track folder) with a
 * `-autotune` suffix so the original is never overwritten. Path safety is
 * enforced the same way as the import-file route: the resolved destination
 * must live inside the caller-supplied setups base dir.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

interface WriteSetupResult {
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
  fileName?: string,
  overwrite = false,
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

  // Stem: the user-supplied name (sanitised — no path parts, safe chars only),
  // or the source name with an -autotune suffix. Collisions auto-increment so
  // a run never clobbers an existing file.
  const stem = fileName ? sanitizeName(fileName) : `${sourceStem(absSource)}-autotune`;
  let dest = resolve(dir, `${stem}.json`);
  // Manual saves claim a new file atomically; a competing save must not be
  // overwritten or later deleted as this invocation's artifact.
  const data = JSON.stringify(setup, null, 2);
  const options = { encoding: "utf-8", flag: overwrite ? "w" : "wx" } as const;
  for (let n = 2; ; n++) {
    try {
      writeFileSync(dest, data, options);
      return { path: dest, fileName: dest.split(/[\\/]/).pop() ?? "" };
    } catch (error) {
      if (overwrite || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      dest = resolve(dir, `${stem}-${n}.json`);
    }
  }
}

function sourceStem(absSource: string): string {
  return (absSource.split(/[\\/]/).pop() ?? "setup").replace(/\.json$/i, "");
}

/** Strip directory parts and unsafe characters so a name can't escape the dir. */
function sanitizeName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/\.json$/i, "");
  const cleaned = base.replace(/[^a-zA-Z0-9 _.-]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "setup-engineer";
}
