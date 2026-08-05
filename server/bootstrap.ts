/**
 * Bootstrap entry point — catches fatal errors that occur before the
 * logger is ready and writes them to a crash log next to the exe
 * (or in the current directory during development).
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

function crashLog(err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  const msg = `[${new Date().toISOString()}] FATAL: ${detail}\n`;
  try {
    process.stderr.write(msg);
  } catch {}
  // Try %APPDATA%/RaceIQ first, fall back to exe directory, then cwd
  const candidates = [
    join(process.env.APPDATA ?? homedir(), "RaceIQ"),
    dirname(process.execPath),
    process.cwd(),
  ];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "crash.log"), msg, { flag: "a" });
      break;
    } catch {}
  }
}

process.on("uncaughtException", (err) => {
  crashLog(err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  crashLog(err);
  process.exit(1);
});

try {
  await import("./index");
} catch (err) {
  crashLog(err);
  process.exit(1);
}
