import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APP_ID = "2399420";

/** Tokenize Valve KeyValues text without treating comments as data. */
function vdfTokens(text: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "/" && text[i + 1] === "/") { i += 2; while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "{" || ch === "}") { tokens.push(ch); i++; continue; }
    if (ch !== '"') { i++; continue; }
    i++;
    let value = "";
    while (i < text.length) {
      const current = text[i++]!;
      if (current === '"') break;
      if (current === "\\" && i < text.length) {
        const escaped = text[i++]!;
        value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      } else value += current;
    }
    tokens.push(value);
  }
  return tokens;
}

type VdfObject = Map<string, string | VdfObject>;
function vdfObject(text: string, objectName: string): VdfObject | null {
  const tokens = vdfTokens(text);
  let depth = 0;
  for (const token of tokens) {
    if (token === "{") depth++;
    else if (token === "}" && --depth < 0) return null;
  }
  if (depth !== 0) return null;
  const opening = tokens.findIndex((token, index) => token.toLowerCase() === objectName.toLowerCase() && tokens[index + 1] === "{");
  if (opening < 0) return null;
  const parse = (start: number): { object: VdfObject; next: number } => {
    const object: VdfObject = new Map();
    let i = start;
    while (i < tokens.length && tokens[i] !== "}") {
      const key = tokens[i++]!;
      if (tokens[i] === "{") {
        const nested = parse(i + 1);
        object.set(key, nested.object);
        i = nested.next;
      } else if (i < tokens.length) object.set(key, tokens[i++]!);
      else break;
    }
    return { object, next: i + 1 };
  };
  return parse(opening + 2).object;
}

export function parseSteamLibraryPaths(text: string): string[] {
  const object = vdfObject(text, "libraryfolders");
  if (!object) return [];
  const entries: { order: number; path: string }[] = [];
  for (const [key, value] of object) {
    if (!/^\d+$/.test(key)) continue;
    const order = Number(key);
    if (!Number.isSafeInteger(order)) continue;
    const path = typeof value === "string" ? value : [...value].find(([name]) => name.toLowerCase() === "path")?.[1];
    if (typeof path === "string" && path) entries.push({ order, path });
  }
  entries.sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  return entries.map(({ path }) => path.replace(/\\/g, sep)).filter((path) => {
    const key = resolve(path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseSteamInstallDir(text: string): string | null {
  const object = vdfObject(text, "appstate");
  const value = object?.get("installdir");
  if (typeof value !== "string" || !value || value === "." || value === ".." || /[\\/]/.test(value) || [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127) || value.trim() !== value) return null;
  return value;
}

function envPath(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() || undefined;
}

async function steamRootFromRegistry(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const systemRoot = envPath("SystemRoot");
  if (!systemRoot) return null;
  try {
    const { stdout } = await execFileAsync(join(systemRoot, "System32", "reg.exe"), ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { timeout: 2000, windowsHide: true });
    const match = stdout.match(/^\s*SteamPath\s+REG_SZ\s+(.+?)\s*$/im);
    return match?.[1] ? resolve(match[1]) : null;
  } catch { return null; }
}

async function settingsFromSteam(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const roots: string[] = [];
  const registry = await steamRootFromRegistry();
  if (registry) roots.push(registry);
  else {
    for (const key of ["ProgramFiles(x86)", "ProgramFiles"]) {
      const root = envPath(key);
      if (root) roots.push(join(root, "Steam"));
    }
  }
  const visited = new Set<string>();
  for (const root of roots) {
    let libraries = [root];
    try { libraries = [...libraries, ...parseSteamLibraryPaths(readFileSync(join(root, "steamapps", "libraryfolders.vdf"), "utf8"))]; }
    catch { /* root library remains usable */ }
    for (const library of libraries) {
      const key = resolve(library).toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      let installDir: string | null;
      try { installDir = parseSteamInstallDir(readFileSync(join(library, "steamapps", `appmanifest_${APP_ID}.acf`), "utf8")); }
      catch { continue; }
      if (!installDir) continue;
      const candidate = join(library, "steamapps", "common", installDir, "UserData", "player", "Settings");
      try { if (statSync(candidate).isDirectory()) return resolve(candidate); } catch { /* skip unavailable install */ }
    }
  }
  return null;
}

/** Find LMU's Settings root, respecting explicit test/process overrides. */
export async function findLMUSetupsDirectory(): Promise<string | null> {
  if (process.env.RACEIQ_SETUP_HOME !== undefined) {
    const home = process.env.RACEIQ_SETUP_HOME;
    if (!home) return null;
    const candidate = join(home, "LMU", "UserData", "player", "Settings");
    try { return statSync(candidate).isDirectory() ? resolve(candidate) : null; } catch { return null; }
  }
  if (process.env.RACEIQ_LMU_SETUP_DIR !== undefined) {
    try {
      const configured = process.env.RACEIQ_LMU_SETUP_DIR;
      return statSync(configured).isDirectory() ? resolve(configured) : null;
    } catch { return null; }
  }
  return settingsFromSteam();
}

