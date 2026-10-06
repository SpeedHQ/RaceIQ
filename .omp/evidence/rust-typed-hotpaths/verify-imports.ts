import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const fixtures = [
  ["fm-2023", "fm-2023-2026-04-09T21-53-00-102Z.bin.gz"],
  ["f1-2025", "f1-2025-2026-04-09T21-34-10-190Z.bin.gz"],
  ["acc", "acc-2026-04-23T16-42-16-158Z.bin.gz"],
  ["ac-evo", "session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz"],
  ["iracing", "iracing-daytona-am-vantage-gt3-pit.bin.gz"],
  ["lmu", "lmu-spa-iron-lynx-gte.bin.gz"],
] as const;
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => key !== "engineSessionId")
    .map((key) => [key, normalize((value as Record<string, unknown>)[key])]));
  return value;
}
const mode = Bun.argv[2] ?? "verify";
if (!["verify", "before", "after"].includes(mode)) throw new Error("Expected verify|before|after");
const directory = ".omp/evidence/rust-typed-hotpaths";
const cases: Record<string, unknown> = {};
for (const [gameId, fixture] of fixtures) {
  const bytes = await Bun.file(`test/artifacts/sessions/${fixture}`).bytes();
  const child = spawn(resolve("native/recorder/target/release/raceiq-recorder"), ["--benchmark-stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = Promise.withResolvers<number | null>();
  child.once("exit", exited.resolve);
  child.once("error", exited.reject);
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  const request = JSON.stringify({ gameId, bytesBase64: Buffer.from(bytes).toString("base64") }) + "\n";
  try {
    const times: number[] = [];
    for (let trial = 0; trial < (mode === "verify" ? 1 : 21); trial++) {
      child.stdin.write(request);
      const line = await replies.next();
      if (line.done) throw new Error(`${gameId}: worker exited without reply`);
      const reply = JSON.parse(line.value);
      if (reply.error) throw new Error(`${gameId}: ${reply.error}`);
      if (mode === "verify") {
        const result = JSON.stringify(normalize(reply.result));
        const baseline = JSON.stringify(normalize(await Bun.file(`.omp/evidence/rust-import-performance-memory/${gameId}-after-result.json`).json()));
        await Bun.write(`${directory}/${gameId}-result.json`, result);
        if (result !== baseline) throw new Error(`${gameId}: complete normalized result mismatch`);
        cases[gameId] = { fixture, digest: createHash("sha256").update(result).digest("hex"), packetCount: reply.result.packetCount, semanticParity: "passed" };
      } else if (trial > 0) times.push(reply.elapsedSeconds);
    }
    if (mode !== "verify") {
      const sorted = [...times].sort((a, b) => a - b);
      cases[gameId] = { fixture, warmups: 1, measuredTrials: times.length, times, median: (sorted[9]! + sorted[10]!) / 2 };
    }
    console.log(JSON.stringify({ gameId, ...cases[gameId] as object }));
    child.stdin.end();
    if (await exited.promise !== 0) throw new Error(`${gameId}: worker failed during shutdown`);
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
await Bun.write(`${directory}/${mode}.json`, JSON.stringify({ mode, cases }, null, 2));
