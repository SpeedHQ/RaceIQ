import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function platformPackageName(): string {
  const { platform, arch } = process;
  if (platform === "win32") {
    return `node-bindings-win32-${arch === "arm64" ? "arm64" : "x64"}`;
  }
  if (platform === "darwin") {
    return `node-bindings-darwin-${arch === "arm64" ? "arm64" : "x64"}`;
  }
  if (platform === "linux") {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const musl = !report?.header?.glibcVersionRuntime;
    return `node-bindings-linux-${arch === "arm64" ? "arm64" : "x64"}${musl ? "-musl" : ""}`;
  }
  throw new Error(`Unsupported platform for DuckDB native addon: ${platform}/${arch}`);
}

export function copyDuckDBRuntime(
  root = process.cwd(),
  distDirectory = join(root, "dist"),
): void {
  const platformPackage = platformPackageName();
  const apiDirectory = dirname(
    Bun.resolveSync("@duckdb/node-api/package.json", root),
  );
  const bindingsDirectory = dirname(
    Bun.resolveSync("@duckdb/node-bindings/package.json", apiDirectory),
  );
  const platformDirectory = dirname(
    Bun.resolveSync(
      `@duckdb/${platformPackage}/package.json`,
      bindingsDirectory,
    ),
  );
  const destination = join(
    distDirectory,
    "node_modules",
    "@duckdb",
    platformPackage,
  );
  mkdirSync(destination, { recursive: true });
  cpSync(platformDirectory, destination, { recursive: true });
  console.log(`Copied DuckDB native addon (@duckdb/${platformPackage})`);
}

if (import.meta.main) copyDuckDBRuntime();
