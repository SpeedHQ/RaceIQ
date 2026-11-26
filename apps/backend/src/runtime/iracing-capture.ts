import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { IS_WINDOWS } from "@raceiq/backend-core/runtime/platform/shell";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { tryGetServerGame } from "@raceiq/backend-core/games/registry";
import { resolveIRacingTelemetryDirectory, setIRacingDiskLogging, isIRacingTelemetryFileClosed, publishIRacingTelemetryFile } from "@raceiq/game-iracing/disk-logging";

export interface IRacingCaptureStatus {
  supported: boolean;
  connected: boolean;
  state: "unavailable" | "disconnected" | "waiting-for-iracing" | "waiting-for-recording" | "recording" | "saving" | "error";
  reason: "unsupported-platform" | "feature-disabled" | "documents-unavailable" | "sdk-command-failed" | "archive-failed" | null;
  sourceDirectory: string | null;
  archiveDirectory: string;
  savedFiles: number;
  lastSavedFile: string | null;
}

export interface IRacingCaptureOptions {
  availability?: () => IRacingCaptureStatus["reason"];
  resolveDirectory?: () => string;
  archiveDirectory?: string;
  setLogging?: (enabled: boolean) => void;
  isFileClosed?: (path: string) => boolean;
  publishFile?: (stage: string, destination: string) => boolean | Promise<boolean>;
  copyFile?: (source: string, destination: string) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  settleMs?: number;
  shutdownFlushMs?: number;
}

interface FileMark { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint }
interface Candidate { mark: FileMark; stableSince: number }
const SOURCE_FRESH_MS = 5000;
const COMMAND_ACK_MS = 10000;
function sameMark(a: FileMark, b: FileMark) {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino;
}
function sdkBoolean(value: unknown): boolean | null {
  return value === true || value === 1 ? true : value === false || value === 0 ? false : null;
}
async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function nativeAvailability(): IRacingCaptureStatus["reason"] {
  if (!IS_WINDOWS) return "unsupported-platform";
  return tryGetServerGame("iracing") ? null : "feature-disabled";
}

/** Runtime opt-in; native originals remain owned by iRacing, never moved or deleted. */
export class IRacingCaptureManager {
  private readonly availability: () => IRacingCaptureStatus["reason"];
  private readonly resolveDirectory: () => string;
  private readonly setLogging: (enabled: boolean) => void;
  private readonly isFileClosed: (path: string) => boolean;
  private readonly publishFile: (stage: string, destination: string) => boolean | Promise<boolean>;
  private readonly copy: (source: string, destination: string) => Promise<void>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly settleMs: number;
  private readonly shutdownFlushMs: number;
  private readonly archiveDirectory: string;
  private connected = false;
  private sourceDirectory: string | null = null;
  private baseline = new Map<string, FileMark>();
  private readonly pending = new Map<string, Candidate>();
  private lastObservation: number | null = null;
  private loggingEnabled: boolean | null = null;
  private recordingActive: boolean | null = null;
  private ownsLogging = false;
  private startRequestedAt: number | null = null;
  private error: IRacingCaptureStatus["reason"] = null;
  private saved = 0;
  private last: string | null = null;
  private saving = false;
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private tickQueued = false;

  constructor(options: IRacingCaptureOptions = {}) {
    this.availability = options.availability ?? nativeAvailability;
    this.resolveDirectory = options.resolveDirectory ?? resolveIRacingTelemetryDirectory;
    this.archiveDirectory = options.archiveDirectory ?? resolve(resolveDataDir(), "sessions", "iracing", "ibt");
    this.setLogging = options.setLogging ?? setIRacingDiskLogging;
    this.isFileClosed = options.isFileClosed ?? isIRacingTelemetryFileClosed;
    this.publishFile = options.publishFile ?? publishIRacingTelemetryFile;
    this.copy = options.copyFile ?? copyFile;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.settleMs = options.settleMs ?? 1000;
    this.shutdownFlushMs = options.shutdownFlushMs ?? 5000;
  }

  status(): IRacingCaptureStatus {
    const unavailable = this.availability();
    const fresh = this.sourceFresh();
    const state: IRacingCaptureStatus["state"] = unavailable ? "unavailable" : this.error ? "error"
      : this.saving || (!this.connected && this.pending.size > 0) ? "saving"
      : !this.connected ? "disconnected" : !fresh ? "waiting-for-iracing"
      : this.recordingActive === true ? "recording" : "waiting-for-recording";
    return { supported: unavailable === null, connected: this.connected, state, reason: unavailable ?? this.error,
      sourceDirectory: this.sourceDirectory, archiveDirectory: this.archiveDirectory, savedFiles: this.saved, lastSavedFile: this.last };
  }

  connect(connected: boolean): Promise<IRacingCaptureStatus> {
    return this.serial(async () => {
      if (!connected) {
        // Discover the final in-window file before ending discovery. The pending set
        // survives disconnect, but subsequent unrelated files are never harvested.
        if (this.connected) await this.scan(true);
        this.stopOwnedLogging();
        this.connected = false;
        await this.scan(false);
        this.updateTimer();
        return;
      }
      if (this.connected || this.availability() !== null) return;
      this.error = null;
      try { this.sourceDirectory = this.resolveDirectory(); }
      catch (error) { this.fail("documents-unavailable", error); return; }
      try {
        await mkdir(this.archiveDirectory, { recursive: true });
        this.baseline = await this.snapshotDirectory();
      } catch (error) { this.fail("archive-failed", error); return; }
      this.connected = true;
      this.startRequestedAt = null;
      this.ownsLogging = false;
      this.updateLogging();
      this.updateTimer();
    }).then(() => this.status());
  }

  /** Called by the existing live source. No FFI or filesystem work on its hot path. */
  observe(snapshot: { values: Record<string, unknown> }, frameTimeMs = this.now()): void {
    if (this.lastObservation !== null && frameTimeMs - this.lastObservation > SOURCE_FRESH_MS) this.forgetOwnership();
    this.lastObservation = frameTimeMs;
    this.loggingEnabled = sdkBoolean(snapshot.values.IsDiskLoggingEnabled);
    this.recordingActive = sdkBoolean(snapshot.values.IsDiskLoggingActive);
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      if (!this.sourceFresh()) this.forgetOwnership();
      if (this.connected) this.updateLogging();
      await this.scan(this.connected);
      this.updateTimer();
    });
  }

  async stop(): Promise<void> {
    await this.connect(false);
    this.clearTimer();
    // SDK stop is asynchronous; allow its final closed file to settle. Use wall
    // time for shutdown so a paused/injected simulator clock cannot hang exit.
    const deadline = Date.now() + this.shutdownFlushMs;
    while (this.pending.size && Date.now() < deadline) {
      await new Promise<void>((done) => setTimeout(done, Math.min(250, this.settleMs || 1)));
      await this.tick();
      this.clearTimer();
    }
    await this.queue;
    if (this.pending.size) console.warn("[iRacing capture] Writer still open at shutdown; native originals remain available", [...this.pending.keys()]);
  }

  private sourceFresh() {
    return this.lastObservation !== null && this.now() - this.lastObservation <= SOURCE_FRESH_MS;
  }
  private forgetOwnership() { this.ownsLogging = false; this.startRequestedAt = null; }
  private updateLogging(): void {
    if (!this.sourceFresh()) return;
    if (this.loggingEnabled === true || this.recordingActive === true) {
      this.startRequestedAt = null;
      if (this.error === "sdk-command-failed") this.error = null;
      return;
    }
    if (this.loggingEnabled !== false || this.recordingActive !== false) return;
    if (this.startRequestedAt !== null) {
      if (this.now() - this.startRequestedAt >= COMMAND_ACK_MS) this.fail("sdk-command-failed", new Error("iRacing did not acknowledge disk logging"));
      return;
    }
    if (this.error === "sdk-command-failed") return;
    try {
      this.setLogging(true);
      this.ownsLogging = true;
      this.startRequestedAt = this.now();
    } catch (error) { this.fail("sdk-command-failed", error); }
  }
  private stopOwnedLogging(): void {
    if (this.ownsLogging && this.sourceFresh()) {
      try { this.setLogging(false); }
      catch (error) { this.fail("sdk-command-failed", error); }
    }
    this.forgetOwnership();
  }
  private fail(reason: IRacingCaptureStatus["reason"], error: unknown): void {
    if (this.error !== reason) console.error("[iRacing capture]", reason, error);
    this.error = reason;
  }
  private serial(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation);
    this.queue = next.catch((error) => this.fail("archive-failed", error));
    return next;
  }
  private updateTimer(): void {
    if (!this.connected && !this.pending.size) { this.clearTimer(); return; }
    if (this.timer || this.pollIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (this.tickQueued) return;
      this.tickQueued = true;
      void this.tick().catch((error) => this.fail("archive-failed", error)).finally(() => { this.tickQueued = false; });
    }, this.pollIntervalMs);
    this.timer.unref();
  }
  private clearTimer(): void { clearInterval(this.timer); this.timer = undefined; }

  private async snapshotDirectory(): Promise<Map<string, FileMark>> {
    const result = new Map<string, FileMark>();
    if (!this.sourceDirectory) return result;
    let entries;
    try { entries = await readdir(this.sourceDirectory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".ibt")) continue;
      try {
        const info = await lstat(join(this.sourceDirectory, entry.name), { bigint: true });
        if (info.isFile()) result.set(entry.name, { size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, ino: info.ino });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return result;
  }

  private async scan(discover: boolean): Promise<void> {
    if (!this.sourceDirectory) return;
    try {
      const current = await this.snapshotDirectory();
      if (discover) {
        for (const [name, mark] of current) {
          const baseline = this.baseline.get(name);
          if (baseline && sameMark(baseline, mark)) continue;
          const pending = this.pending.get(name);
          if (!pending || !sameMark(pending.mark, mark)) this.pending.set(name, { mark, stableSince: this.now() });
        }
      }
      for (const [name, candidate] of this.pending) {
        const mark = current.get(name);
        if (!mark) { this.pending.delete(name); continue; }
        if (!sameMark(candidate.mark, mark)) { this.pending.set(name, { mark, stableSince: this.now() }); continue; }
        if (this.now() - candidate.stableSince < this.settleMs) continue;
        const source = join(this.sourceDirectory, name);
        if (!this.isFileClosed(source)) continue;
        if (mark.size === 0n) throw new Error("Completed iRacing telemetry file is empty");
        await this.archive(source, name, mark);
        this.baseline.set(name, mark);
        this.pending.delete(name);
      }
    } catch (error) { this.fail("archive-failed", error); }
  }

  private async archive(source: string, name: string, mark: FileMark): Promise<void> {
    const stage = join(this.archiveDirectory, `.${randomUUID()}.tmp`);
    this.saving = true;
    try {
      await this.copy(source, stage);
      const from = await lstat(source, { bigint: true });
      const staged = await lstat(stage, { bigint: true });
      if (!from.isFile() || !sameMark(mark, from) || staged.size !== mark.size || !this.isFileClosed(source)) throw new Error("iRacing source changed during archive copy");
      const hash = await digest(stage);
      const stem = basename(name, name.slice(-4)).slice(0, 140);
      const destination = join(this.archiveDirectory, `${stem}-${hash}.ibt`);
      if (await this.publishFile(stage, destination)) {
        this.saved++;
        this.last = destination;
      } else if (await digest(destination) !== hash) throw new Error("Existing iRacing archive content does not match its identity");
      if (this.error === "archive-failed") this.error = null;
    } finally {
      await rm(stage, { force: true });
      this.saving = false;
    }
  }
}

export const iracingCaptureManager = new IRacingCaptureManager();
