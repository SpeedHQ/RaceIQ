import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

type ProcessRow = { parent: number; cpuSeconds: number; rssBytes: number };

export function readProcessOutput(command: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new Error(`Process sampling failed (${command}): ${stderr.trim() || error.message}`, { cause: error }));
    else resolve(stdout);
  });
  return promise;
}

async function processTable(): Promise<Map<number, ProcessRow>> {
  if (process.platform === "win32") {
    // Win32_Process reports CPU time in 100-nanosecond ticks and working set in bytes.
    const text = await readProcessOutput("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, KernelModeTime, UserModeTime, WorkingSetSize)",
    ]);
    return parseWindowsProcessRows(text);
  }
  return parseProcessRows(await readProcessOutput("ps", ["-axo", "pid=,ppid=,time=,rss="]));
}

export function parseWindowsProcessRows(text: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  const processes: {
    ProcessId: number;
    ParentProcessId: number;
    KernelModeTime: string | number;
    UserModeTime: string | number;
    WorkingSetSize: string | number;
  }[] = JSON.parse(text.trim().replace(/^\uFEFF/, ""));
  for (const row of processes) rows.set(row.ProcessId, {
    parent: row.ParentProcessId,
    cpuSeconds: (Number(row.KernelModeTime) + Number(row.UserModeTime)) / 10_000_000,
    rssBytes: Number(row.WorkingSetSize),
  });
  return rows;
}

export function parseProcessRows(text: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(\d+)$/);
    if (match) rows.set(Number(match[1]), {
      parent: Number(match[2]),
      cpuSeconds: Number(match[3] ?? 0) * 86400 + Number(match[4] ?? 0) * 3600 + Number(match[5]) * 60 + Number(match[6]),
      rssBytes: Number(match[7]) * 1024,
    });
  }
  return rows;
}

function descendants(rows: Map<number, ProcessRow>, rootPid: number): number[] {
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, row] of rows) if (!pids.has(pid) && pids.has(row.parent)) { pids.add(pid); changed = true; }
  }
  return [...pids];
}

export class ProcessTreeSampler {
  #proc: ChildProcess | number;
  #ownPidOnly: boolean;
  #initialCpu = new Map<number, number>();
  #maxCpu = new Map<number, number>();
  #peakRssBytes = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #pendingSample: Promise<void> | null = null;
  #sampleError: unknown = null;

  constructor(proc: ChildProcess | number, ownPidOnly = false) { this.#proc = proc; this.#ownPidOnly = ownPidOnly; }
  #rootPid(): number { return typeof this.#proc === "number" ? this.#proc : this.#proc.pid!; }
  #pids(rows: Map<number, ProcessRow>): number[] { return this.#ownPidOnly ? [this.#rootPid()] : descendants(rows, this.#rootPid()); }

  async start(): Promise<void> { await this.mark(); await this.#sample(); }
  async mark(): Promise<void> {
    const rows = await processTable();
    if (!rows.has(this.#rootPid())) throw new Error(`No process resource sample for root PID ${this.#rootPid()}`);
    this.#initialCpu.clear(); this.#maxCpu.clear(); this.#peakRssBytes = 0;
    for (const pid of this.#pids(rows)) { const row = rows.get(pid); if (row) this.#initialCpu.set(pid, row.cpuSeconds); }
  }
  async #sample(): Promise<void> {
    if (this.#stopped) return;
    const rows = await processTable(); let rss = 0;
    for (const pid of this.#pids(rows)) {
      const row = rows.get(pid); if (!row) continue;
      if (!this.#initialCpu.has(pid)) this.#initialCpu.set(pid, row.cpuSeconds);
      rss += row.rssBytes; this.#maxCpu.set(pid, Math.max(this.#maxCpu.get(pid) ?? 0, row.cpuSeconds));
    }
    this.#peakRssBytes = Math.max(this.#peakRssBytes, rss);
    if (!this.#stopped) this.#timer = setTimeout(() => {
      this.#pendingSample = this.#sample().catch((error: unknown) => { this.#sampleError = error; });
    }, 100);
  }
  async stop(): Promise<{ cpuSeconds: number; peakRssBytes: number }> {
    this.#stopped = true; clearTimeout(this.#timer ?? undefined);
    await this.#pendingSample;
    if (this.#sampleError) throw this.#sampleError;
    const rows = await processTable(); let rss = 0;
    for (const pid of this.#pids(rows)) {
      const row = rows.get(pid); if (!row) continue;
      rss += row.rssBytes;
      if (this.#initialCpu.has(pid)) this.#maxCpu.set(pid, Math.max(this.#maxCpu.get(pid) ?? 0, row.cpuSeconds));
    }
    this.#peakRssBytes = Math.max(this.#peakRssBytes, rss);
    let cpuSeconds = 0;
    for (const [pid, initial] of this.#initialCpu) cpuSeconds += Math.max(0, (this.#maxCpu.get(pid) ?? initial) - initial);
    return { cpuSeconds, peakRssBytes: this.#peakRssBytes };
  }
}
