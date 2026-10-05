import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

type ProcessRow = { parent: number; cpuSeconds: number; rssBytes: number };

async function processTable(): Promise<Map<number, ProcessRow>> {
  const child = spawn("ps", ["-axo", "pid=,ppid=,time=,rss="], { stdio: ["ignore", "pipe", "ignore"] });
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  const exit = Promise.withResolvers<void>();
  child.once("exit", exit.resolve);
  await exit.promise;
  const rows = new Map<number, ProcessRow>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+):(\d+(?:\.\d+)?)\s+(\d+)$/);
    if (match) rows.set(Number(match[1]), { parent: Number(match[2]), cpuSeconds: Number(match[3]) * 60 + Number(match[4]), rssBytes: Number(match[5]) * 1024 });
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
  #proc: ChildProcess;
  #initialCpu = new Map<number, number>();
  #maxCpu = new Map<number, number>();
  #peakRssBytes = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(proc: ChildProcess) { this.#proc = proc; }

  async start(): Promise<void> {
    await this.mark();
    await this.#sample();
  }

  async mark(): Promise<void> {
    const rows = await processTable();
    this.#initialCpu.clear();
    this.#maxCpu.clear();
    this.#peakRssBytes = 0;
    for (const pid of descendants(rows, this.#proc.pid!)) {
      const row = rows.get(pid);
      if (row) this.#initialCpu.set(pid, row.cpuSeconds);
    }
  }

  async #sample(): Promise<void> {
    if (this.#stopped) return;
    const rows = await processTable();
    const pids = descendants(rows, this.#proc.pid!);
    let rssBytes = 0;
    for (const pid of pids) {
      const row = rows.get(pid);
      if (!row) continue;
      if (!this.#initialCpu.has(pid)) this.#initialCpu.set(pid, row.cpuSeconds);
      rssBytes += row.rssBytes;
      this.#maxCpu.set(pid, Math.max(this.#maxCpu.get(pid) ?? 0, row.cpuSeconds));
    }
    this.#peakRssBytes = Math.max(this.#peakRssBytes, rssBytes);
    if (!this.#stopped) this.#timer = setTimeout(() => { void this.#sample(); }, 100);
  }

  async stop(): Promise<{ cpuSeconds: number; peakRssBytes: number }> {
    this.#stopped = true;
    clearTimeout(this.#timer ?? undefined);
    const rows = await processTable();
    for (const [pid, row] of rows) {
      if (this.#initialCpu.has(pid)) this.#maxCpu.set(pid, Math.max(this.#maxCpu.get(pid) ?? 0, row.cpuSeconds));
    }
    let cpuSeconds = 0;
    for (const [pid, initial] of this.#initialCpu) cpuSeconds += Math.max(0, (this.#maxCpu.get(pid) ?? initial) - initial);
    return { cpuSeconds, peakRssBytes: this.#peakRssBytes };
  }
}
