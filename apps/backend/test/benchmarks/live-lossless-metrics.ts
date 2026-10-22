import { createHash } from "node:crypto";
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { dlopen, ptr } from "bun:ffi";

export class NativeRecordDigest {
  count = 0;
  bytes = 0;
  private readonly hash = createHash("sha256");
  private readonly prefix = Buffer.alloc(13);
  add(frame: Uint8Array, timestampMs?: number): void {
    this.prefix.writeUInt32LE(frame.byteLength, 0);
    this.prefix[4] = timestampMs === undefined ? 0 : 1;
    this.prefix.writeDoubleLE(timestampMs === undefined ? 0 : timestampMs, 5);
    this.hash.update(this.prefix).update(frame);
    this.count++;
    this.bytes += frame.byteLength;
  }
  digest(): string { return this.hash.copy().digest("hex"); }
}

export class LatencyHistogram {
  private readonly histogram = createHistogram();
  record(nanoseconds: number): void { this.histogram.record(Math.max(1, Math.round(nanoseconds))); }
  snapshot() {
    const h = this.histogram;
    return { p50: h.count ? h.percentile(50) / 1e6 : 0, p95: h.count ? h.percentile(95) / 1e6 : 0,
      p99: h.count ? h.percentile(99) / 1e6 : 0, max: h.count ? h.max / 1e6 : 0, samples: h.count };
  }
}

const rusage = process.platform === "darwin" ? dlopen("/usr/lib/libproc.dylib", {
  proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
}) : null;
const usageBuffer = Buffer.alloc(160);
export function processDiskBytes(): { read: number; written: number } {
  if (!rusage) throw new Error(`OS-attributed disk measurements unavailable on ${process.platform}; release budgets cannot pass`);
  if (rusage.symbols.proc_pid_rusage(process.pid, 2, ptr(usageBuffer)) !== 0) throw new Error("proc_pid_rusage failed");
  const read = Number(usageBuffer.readBigUInt64LE(144)), written = Number(usageBuffer.readBigUInt64LE(152));
  if (!Number.isSafeInteger(read) || !Number.isSafeInteger(written)) throw new Error("OS disk counter exceeds numeric range");
  return { read, written };
}

export function observeEventLoop() {
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  return () => {
    delay.disable();
    return { p50: delay.count ? delay.percentile(50) / 1e6 : 0, p95: delay.count ? delay.percentile(95) / 1e6 : 0,
      p99: delay.count ? delay.percentile(99) / 1e6 : 0, max: delay.count ? delay.max / 1e6 : 0, samples: delay.count };
  };
}
