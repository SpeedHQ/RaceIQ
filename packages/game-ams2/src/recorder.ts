import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AMS2_DUMP_MAGIC } from "@raceiq/capture-formats/ams2/dump";
import { decodeAMS2Frame } from "./frame";

export interface AMS2RecorderContract {
  readonly recording: boolean;
  start(directory?: string): string;
  writeFrame(frame: Buffer): void;
  flush(): void;
  stop(): Promise<void>;
}

export class AMS2DumpRecorder implements AMS2RecorderContract {
  private sink: Bun.FileSink | null = null;
  private path: string | null = null;
  private count = 0;
  private stopping: Promise<void> | null = null;
  get recording(): boolean {
    return this.sink !== null;
  }
  start(directory = resolve(process.cwd(), "test/artifacts/sessions")): string {
    if (this.sink && this.path) return this.path;
    if (this.stopping) throw new Error("AMS2 dump is still flushing");
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = resolve(directory, `ams2-${stamp}-${randomUUID().slice(0, 8)}.bin`);
    this.sink = Bun.file(this.path).writer();
    this.count = 0;
    const header = Buffer.alloc(16);
    AMS2_DUMP_MAGIC.copy(header);
    header.writeUInt32LE(1, 8);
    this.sink.write(header);
    this.sink.flush();
    return this.path;
  }
  writeFrame(frame: Buffer): void {
    if (!this.sink) throw new Error("AMS2 dump recorder is not running");
    if (!decodeAMS2Frame(frame)) throw new Error("Invalid AMS2 source frame");
    const size = Buffer.allocUnsafe(4);
    size.writeUInt32LE(frame.length);
    this.sink.write(size);
    this.sink.write(frame);
    this.count++;
  }
  flush(): void {
    this.sink?.flush();
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.sink || !this.path) return;
    const sink = this.sink,
      filePath = this.path,
      count = this.count;
    this.sink = null;
    this.stopping = (async () => {
      await sink.end();
      const fd = openSync(filePath, "r+");
      try {
        const bytes = Buffer.allocUnsafe(4);
        bytes.writeUInt32LE(count);
        writeSync(fd, bytes, 0, 4, 12);
      } finally {
        closeSync(fd);
      }
      console.log(`[AMS2] Dump flushed: ${count} source frames → ${filePath}`);
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }
}
