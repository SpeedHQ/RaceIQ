/**
 * Buffers console output within a test and flushes it as a single atomic block.
 * Prevents interleaved output when tests run in parallel across worker threads.
 *
 * flush() writes directly to stdout, bypassing any console.log suppression
 * that the test file may apply to silence noisy internal logs.
 *
 * Usage:
 *   const log = new TestLogger("acc-2026-04-12T21-44-38-899Z");
 *   log.log("  Lap 0: ...");
 *   log.flush(); // call at end of test
 */
export class TestLogger {
  private lines: string[] = [];

  constructor(private readonly label: string) {}

  log(line: string): void {
    this.lines.push(line);
  }

  /** Print all buffered lines as one contiguous block with a header. */
  flush(): void {
    const out = [`\n── ${this.label} ─────────────────────────`, ...this.lines].join("\n") + "\n";
    process.stdout.write(out);
  }
}
