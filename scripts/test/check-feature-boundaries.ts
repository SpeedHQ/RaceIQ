import { parse } from "@babel/parser";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const sourceExtensions = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const serverModules = /^(?:node:|bun:|libsql(?:\/|$)|drizzle-orm(?:\/|$)|@libsql\/|@mastra\/|@raceiq\/backend(?:-core)?(?:\/|$))/;

type SyntaxNode = { type: string; [key: string]: unknown };

function node(value: unknown): value is SyntaxNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function literal(value: unknown): string | undefined {
  if (!node(value)) return undefined;
  return value.type === "StringLiteral" && typeof value.value === "string" ? value.value : undefined;
}

function imports(source: string, file: string): string[] {
  let ast;
  try {
    ast = parse(source, { sourceType: "unambiguous", plugins: file.endsWith(".tsx") || file.endsWith(".jsx") ? ["typescript", "jsx"] : ["typescript"], sourceFilename: file });
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!node(value)) return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(value.type)) {
      const specifier = literal(value.source);
      if (specifier) result.add(specifier);
    } else if (value.type === "ImportExpression" || value.type === "TSImportType") {
      const specifier = literal(value.source ?? value.argument);
      if (specifier) result.add(specifier);
    } else if (value.type === "CallExpression" && node(value.callee)) {
      const callee = value.callee;
      const requireCall = callee.type === "Identifier" && callee.name === "require";
      const moduleRequire = callee.type === "MemberExpression" && node(callee.object) && callee.object.type === "Identifier" && callee.object.name === "module" && node(callee.property) && callee.property.type === "Identifier" && callee.property.name === "require";
      if (requireCall || moduleRequire || callee.type === "Import") {
        const args = value.arguments;
        const specifier = Array.isArray(args) ? literal(args[0]) : undefined;
        if (specifier) result.add(specifier);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!["loc", "start", "end", "comments", "tokens"].includes(key)) visit(child);
    }
  };
  visit(ast.program);
  return [...result];
}

function resolveSource(specifier: string, importer: string): string | undefined {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(importer), specifier);
    const candidates = [base, ...sourceExtensions.map((extension) => base + extension), ...sourceExtensions.map((extension) => resolve(base, "index" + extension))];
    for (const candidate of candidates) {
      if (existsSync(candidate) && sourceExtensions.some((extension) => candidate.endsWith(extension))) return realpathSync(candidate);
    }
    return undefined;
  }
  try {
    const target = Bun.resolveSync(specifier, dirname(importer));
    return existsSync(target) ? realpathSync(target) : undefined;
  } catch {
    // The compiler checks unresolved external modules; this gate checks ownership.
    return undefined;
  }
}

export function checkFeatureBoundaries(root: string, feature: string): string[] {
  if (!/^[a-z][a-z0-9-]*$/.test(feature)) throw new Error(`Invalid feature name: ${feature}`);
  const rootPath = realpathSync(root);
  const featureRoot = resolve(rootPath, "packages", feature);
  const manifest = JSON.parse(readFileSync(resolve(featureRoot, "package.json"), "utf8")) as { exports?: Record<string, unknown> };
  const errors: string[] = [];
  if (manifest.exports?.["."] !== undefined || Object.keys(manifest.exports ?? {}).some((key) => key.includes("*"))) {
    errors.push(`${feature}: mixed root/wildcard exports are forbidden`);
  }
  for (const entry of ["ui", "server", "contracts"] as const) {
    if (typeof manifest.exports?.[`./${entry}`] !== "string") errors.push(`${feature}: missing explicit ./${entry} export`);
  }
  const display = (file: string) => relative(rootPath, file).split(sep).join("/");
  for (const area of ["ui", "contracts", "server"] as const) {
    const areaRoot = resolve(featureRoot, area);
    if (!existsSync(areaRoot)) {
      errors.push(`${feature}: missing ${area}/ directory`);
      continue;
    }
    const visited = new Set<string>();
    const visit = (file: string): void => {
      const canonical = realpathSync(file);
      if (visited.has(canonical) || canonical.split(sep).includes("node_modules")) return;
      visited.add(canonical);
      const browser = area !== "server";
      for (const specifier of imports(readFileSync(canonical, "utf8"), canonical)) {
        if (specifier.startsWith("@/") || specifier === "client" || specifier.startsWith("client/")) {
          errors.push(`${display(canonical)}: reverse client dependency ${specifier}`);
          continue;
        }
        if (browser && (serverModules.test(specifier) || (specifier === "hono" || specifier.startsWith("@hono/")))) {
          errors.push(`${display(canonical)}: browser ${area} imports server module ${specifier}`);
          continue;
        }
        const target = resolveSource(specifier, canonical);
        if (!target || target.split(sep).includes("node_modules") || !sourceExtensions.some((extension) => target.endsWith(extension))) continue;
        const path = display(target);
        const appSource = path.startsWith("client/") || path.startsWith("apps/backend/");
        const featureServer = /^packages\/[^/]+\/server\//.test(path);
        const featureUi = /^packages\/[^/]+\/ui\//.test(path);
        const sharedBackend = path.startsWith("server/");
        if (appSource || (browser && (featureServer || sharedBackend)) || (area === "server" && featureUi) || (area === "contracts" && featureUi)) {
          errors.push(`${display(canonical)}: ${area} crosses ownership boundary via ${specifier} -> ${path}`);
          continue;
        }
        visit(target);
      }
    };
    for (const file of new Bun.Glob("**/*.{ts,tsx,mts,js,jsx,mjs}").scanSync({ cwd: areaRoot, onlyFiles: true })) visit(resolve(areaRoot, file));
  }
  return [...new Set(errors)];
}

if (import.meta.main) {
  const feature = process.argv[2];
  if (!feature) {
    console.error("Usage: bun scripts/test/check-feature-boundaries.ts <feature>");
    process.exit(2);
  }
  try {
    const errors = checkFeatureBoundaries(resolve(import.meta.dir, "../.."), feature);
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log(`${feature}: UI/server/contracts boundaries passed`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
