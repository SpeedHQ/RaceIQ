import { existsSync, readFileSync } from "node:fs";

const STEAM_LIBRARY_FOLDERS_VDF = "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf";

/**
 * Finds a game directory from Steam libraryfolders.vdf, then tries caller-provided fallbacks.
 */
export function findSteamInstall(
  gameDirectory: string,
  fallbacks?: readonly string[],
): string | null {
  if (existsSync(STEAM_LIBRARY_FOLDERS_VDF)) {
    const content = readFileSync(STEAM_LIBRARY_FOLDERS_VDF, "utf8");
    const pathRegex = /"path"\s+"([^"]+)"/g;
    while (true) {
      const match = pathRegex.exec(content);
      if (match === null) break;
      const libraryPath = match[1].replace(/\\\\/g, "/").replace(/\\/g, "/");
      const installPath = `${libraryPath}/steamapps/common/${gameDirectory}`;
      if (existsSync(installPath)) return installPath;
    }
  }

  if (fallbacks) {
    for (const fallback of fallbacks) {
      if (existsSync(fallback)) return fallback;
    }
  }

  return null;
}
