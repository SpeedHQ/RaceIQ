import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const settingsPath = resolve(root, "client/project.inlang/settings.json");
const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
  baseLocale: string;
  locales: string[];
};
const messagesDir = resolve(root, "client/messages");

async function readCatalog(locale: string): Promise<Record<string, unknown>> {
  const path = resolve(messagesDir, `${locale}.json`);
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const base = await readCatalog(settings.baseLocale);
const baseKeys = new Set(Object.keys(base).filter((key) => key !== "$schema"));
let failed = false;

for (const locale of settings.locales) {
  if (locale === settings.baseLocale) continue;

  const catalog = await readCatalog(locale);
  const localeKeys = new Set(Object.keys(catalog).filter((key) => key !== "$schema"));
  const missing = [...baseKeys].filter((key) => !localeKeys.has(key)).sort();
  const extra = [...localeKeys].filter((key) => !baseKeys.has(key)).sort();

  if (localeKeys.size === baseKeys.size && missing.length === 0 && extra.length === 0) {
    console.log(`${locale}: complete (${localeKeys.size}/${baseKeys.size} message keys)`);
    continue;
  }

  failed = true;
  console.error(
    `${locale}: ${localeKeys.size}/${baseKeys.size} message keys; ${missing.length} missing, ${extra.length} extra`,
  );
  for (const key of missing.slice(0, 20)) console.error(`  missing: ${key}`);
  if (missing.length > 20) console.error(`  ... ${missing.length - 20} more missing`);
  for (const key of extra.slice(0, 20)) console.error(`  extra: ${key}`);
  if (extra.length > 20) console.error(`  ... ${extra.length - 20} more extra`);
}

if (failed) process.exitCode = 1;
