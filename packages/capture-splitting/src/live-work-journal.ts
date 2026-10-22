import { open, mkdir, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { deserialize, serialize } from "node:v8";

const HEADER_BYTES = 4;
export interface LiveWorkJournalLimits {
  readonly maxPendingBytes: number;
  readonly maxPendingRecords: number;
  readonly maxRecordBytes: number;
}

/** Append-only worker-owned control spool. Pending reservations stay byte/count bounded; records retain Uint8Array via V8 serialization. */
export class LiveWorkJournal<T> {
  private handle: FileHandle | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writeOffset = 0;
  private readOffset = 0;
  private pendingRecords = 0;
  private pendingBytes = 0;
  private failure: Error | null = null;
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private lookupActive = false;
  private readonly path: string;
  private readonly limits: LiveWorkJournalLimits;

  private constructor(path: string, limits: LiveWorkJournalLimits) { this.path = path; this.limits = limits; }

  static async create<T>(path: string, limits: LiveWorkJournalLimits): Promise<LiveWorkJournal<T>> {
    if (![limits.maxPendingBytes, limits.maxPendingRecords, limits.maxRecordBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
        limits.maxRecordBytes > limits.maxPendingBytes) throw new RangeError("Invalid live work journal limits");
    await mkdir(dirname(path), { recursive: true });
    const journal = new LiveWorkJournal<T>(path, limits);
    journal.handle = await open(path, "wx+");
    return journal;
  }

  get pending(): { bytes: number; records: number; unreadBytes: number } {
    return { bytes: this.pendingBytes, records: this.pendingRecords, unreadBytes: this.writeOffset - this.readOffset };
  }

  append(value: T): Promise<void> { return this.appendSerialized(serialize(value)); }

  async appendSerialized(payload: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed || !this.handle) throw new Error("Live work journal is closed");
    const bytes = payload.byteLength + HEADER_BYTES;
    if (payload.byteLength > this.limits.maxRecordBytes) throw new Error("Live work journal record exceeds byte limit");
    if (bytes > this.limits.maxPendingBytes || this.pendingBytes + bytes > this.limits.maxPendingBytes ||
        this.pendingRecords + 1 > this.limits.maxPendingRecords) throw new Error("Live work journal reservation exhausted");
    this.pendingBytes += bytes;
    this.pendingRecords++;
    const job = this.writeChain.then(async () => {
      if (!this.handle || this.closed) throw new Error("Live work journal closed during append");
      const header = Buffer.allocUnsafe(HEADER_BYTES);
      header.writeUInt32LE(payload.byteLength);
      await this.writeAll(header, this.writeOffset);
      await this.writeAll(payload, this.writeOffset + HEADER_BYTES);
      this.writeOffset += bytes;
    });
    this.writeChain = job.catch((error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.wakeReader();
    });
    try { await job; }
    finally {
      this.pendingBytes -= bytes;
      this.pendingRecords--;
      this.wakeReader();
    }
  }

  async *readAvailable(): AsyncGenerator<T> {
    while (!this.closed) {
      if (this.failure) throw this.failure;
      if (this.readOffset < this.writeOffset) {
        const record = await this.readRecord(this.readOffset);
        this.readOffset = record.nextOffset;
        yield record.value;
        continue;
      }
      await this.waitForAppend();
    }
  }

  /** Consume a bounded run already on disk; leave the first nonmatch visible to ordered replay and lookahead. */
  async consumeAvailableWhile(predicate: (value: T) => boolean, consume: (value: T) => void, maxRecords: number): Promise<void> {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new RangeError("Invalid live journal consume limit");
    for (let count = 0; count < maxRecords && !this.closed; count++) {
      if (this.failure) throw this.failure;
      if (this.readOffset >= this.writeOffset) break;
      const record = await this.readRecord(this.readOffset);
      if (!predicate(record.value)) break;
      this.readOffset = record.nextOffset;
      consume(record.value);
    }
  }

  /** Resolve late identity without retaining future lap controls or advancing ordered replay. */
  async findPending(predicate: (value: T) => boolean): Promise<T> {
    if (this.lookupActive) throw new Error("Concurrent live journal lookahead is not allowed");
    this.lookupActive = true;
    let offset = this.readOffset;
    try {
      for (;;) {
        if (this.failure) throw this.failure;
        if (this.closed) throw new Error("Live journal closed before required identity arrived");
        if (offset < this.writeOffset) {
          const record = await this.readRecord(offset);
          offset = record.nextOffset;
          if (predicate(record.value)) return record.value;
        } else await this.waitForAppend();
      }
    } finally { this.lookupActive = false; }
  }

  private async readRecord(offset: number): Promise<{ value: T; nextOffset: number }> {
    if (!this.handle) throw new Error("Live work journal file is unavailable");
    const header = await this.readExact(offset, HEADER_BYTES);
    const length = header.readUInt32LE(0);
    if (length > this.limits.maxRecordBytes || offset + HEADER_BYTES + length > this.writeOffset) throw new Error("Live work journal contains an invalid record boundary");
    const payload = await this.readExact(offset + HEADER_BYTES, length);
    return { value: deserialize(payload) as T, nextOffset: offset + HEADER_BYTES + length };
  }

  private async waitForAppend(): Promise<void> {
    if (this.waiters.length >= 2) throw new Error("Live work journal reader budget exhausted");
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  async close(remove = true): Promise<void> {
    if (this.closed) return;
    await this.writeChain;
    this.closed = true;
    this.wakeReader();
    await this.handle?.close();
    this.handle = null;
    if (remove) await rm(this.path, { force: true });
  }

  private async writeAll(bytes: Uint8Array, position: number): Promise<void> {
    const handle = this.handle;
    if (!handle) throw new Error("Live work journal file is unavailable");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
      if (bytesWritten === 0) throw new Error("Live work journal made no write progress");
      offset += bytesWritten;
    }
  }

  private async readExact(position: number, length: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await this.handle!.read(result, offset, length - offset, position + offset);
      if (bytesRead === 0) throw new Error("Live work journal ended inside a record");
      offset += bytesRead;
    }
    return result;
  }

  private wakeReader(): void {
    while (this.waiters.length) this.waiters.pop()!();
  }
}
