import { existsSync, readFileSync } from "node:fs";

export function findForzaInstall(): string | null {
  const vdfPath =
    "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf";
  if (!existsSync(vdfPath)) return null;

  const content = readFileSync(vdfPath, "utf8");

  // Parse library paths from VDF
  const pathRegex = /"path"\s+"([^"]+)"/g;
  const paths: string[] = [];

  while (true) {
    const match = pathRegex.exec(content);
    if (match === null) break;
    paths.push(match[1].replace(/\\\\/g, "/").replace(/\\/g, "/"));
  }

  for (const libPath of paths) {
    const forzaPath = `${libPath}/steamapps/common/Forza Motorsport`;
    if (existsSync(forzaPath)) {
      return forzaPath;
    }
  }

  return null;
}
