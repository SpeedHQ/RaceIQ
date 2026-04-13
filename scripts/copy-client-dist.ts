import { cpSync, mkdirSync } from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
mkdirSync(path.join(ROOT, "dist"), { recursive: true });
cpSync(path.join(ROOT, "client", "dist"), path.join(ROOT, "dist", "public"), { recursive: true });
