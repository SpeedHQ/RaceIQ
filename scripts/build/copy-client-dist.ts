import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
mkdirSync(path.join(ROOT, "dist"), { recursive: true });
cpSync(path.join(ROOT, "client", "dist"), path.join(ROOT, "dist", "public"), { recursive: true });
