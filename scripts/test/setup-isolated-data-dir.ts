import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
for (const line of readFileSync(resolve(root, ".env.development"), "utf8").split(/\r?\n/)) {
  const separator = line.indexOf("=");
  if (separator < 1) continue;
  const name = line.slice(0, separator);
  if (!["RACEIQ_FEATURE_F1_EXPERIMENTS", "RACEIQ_FEATURE_IRACING_ADAPTER"].includes(name)) continue;
  process.env[name] = line.slice(separator + 1);
}

process.env.RACEIQ_TEST_MODE = "1";
const dataDir = process.env.RACEIQ_TEST_DATA_DIR ?? process.env.DATA_DIR;
if (!dataDir) throw new Error("Test runner must provide an isolated DATA_DIR");
process.env.DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
writeFileSync(resolve(dataDir, "settings.json"), "{}\n");
