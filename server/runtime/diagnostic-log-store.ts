import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

const ACTIVE_NAME = "raceiq.log";
const ROTATED_RE = /^raceiq(?:-|\.)(?:\d|20\d{2}).*\.log$/;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 25 * 60 * 60 * 1000;

type DiagnosticLogStoreOptions = {
  directory: string;
  now?: () => number;
  maxFileBytes?: number;
  retentionMs?: number;
};

export function createDiagnosticLogStore(options: DiagnosticLogStoreOptions) {
  const now = options.now ?? Date.now;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const activePath = join(options.directory, ACTIVE_NAME);
  let counter = 0;
  mkdirSync(options.directory, { recursive: true });

  function files(): string[] {
    try {
      return readdirSync(options.directory).filter((name) => ROTATED_RE.test(name));
    } catch {
      return [];
    }
  }

  function prune(): void {
    const cutoff = now() - retentionMs;
    for (const name of files()) {
      const path = join(options.directory, name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // Best effort; readable files remain available.
      }
    }
  }

  function rotate(): boolean {
    try {
      if (!existsSync(activePath)) return true;
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      let path: string;
      do {
        counter += 1;
        path = join(options.directory, `raceiq-${stamp}-${process.pid}-${counter}.log`);
      } while (existsSync(path));
      renameSync(activePath, path);
      prune();
      return true;
    } catch {
      return false;
    }
  }

  function startRun(): void {
    try {
      if (existsSync(activePath) && statSync(activePath).size >= maxFileBytes) rotate();
      appendFileSync(activePath, `=== RaceIQ started ${new Date(now()).toISOString()} ===\n`);
      prune();
    } catch {
      // Logging must not prevent application startup.
    }
  }

  function write(line: string): void {
    const data = Buffer.from(line);
    try {
      const size = existsSync(activePath) ? statSync(activePath).size : 0;
      if (size > 0 && size + data.byteLength > maxFileBytes) rotate();
      appendFileSync(activePath, data);
      prune();
    } catch {
      // Preserve application behavior when diagnostics storage is unavailable.
    }
  }

  function readRetainedText(): string {
    const cutoff = now() - retentionMs;
    const eligible = files()
      .map((name) => ({ name, path: join(options.directory, name) }))
      .filter(({ path }) => {
        try { return statSync(path).mtimeMs >= cutoff; } catch { return false; }
      })
      .sort((a, b) => {
        const sa = statSync(a.path); const sb = statSync(b.path);
        return sa.mtimeMs - sb.mtimeMs || a.name.localeCompare(b.name);
      });
    const paths = [...eligible.map(({ path }) => path), activePath];
    const chunks: Buffer[] = [];
    for (const path of paths) {
      try {
        if (!existsSync(path)) continue;
        const data = readFileSync(path);
        if (data.length) {
          if (chunks.length && !chunks[chunks.length - 1].subarray(-1).equals(Buffer.from("\n"))) chunks.push(Buffer.from("\n"));
          chunks.push(data);
        }
      } catch {
        if (chunks.length && !chunks[chunks.length - 1].subarray(-1).equals(Buffer.from("\n"))) chunks.push(Buffer.from("\n"));
        chunks.push(Buffer.from("[diagnostic log read failed]\n"));
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  return { startRun, write, readRetainedText };
}
