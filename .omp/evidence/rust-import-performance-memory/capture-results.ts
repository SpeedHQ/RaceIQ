import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const fixtures = [
  ['fm-2023', 'fm-2023-2026-04-09T21-53-00-102Z.bin.gz'],
  ['f1-2025', 'f1-2025-2026-04-09T21-34-10-190Z.bin.gz'],
  ['acc', 'acc-2026-04-23T16-42-16-158Z.bin.gz'],
  ['ac-evo', 'session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz'],
  ['iracing', 'iracing-daytona-am-vantage-gt3-pit.bin.gz'],
  ['lmu', 'lmu-spa-iron-lynx-gte.bin.gz'],
] as const;

type Reply = { error?: string; result: unknown; elapsedSeconds: number };

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'engineSessionId').sort()
    .map(([key, child]) => [key, normalize(child)]));
  return value;
}

function packetCount(result: unknown): number | undefined {
  if (result && typeof result === 'object' && 'packetCount' in result && typeof result.packetCount === 'number') return result.packetCount;
  return undefined;
}

const mode = process.argv[2] ?? 'baseline';
if (!['baseline', 'verify', 'timing'].includes(mode)) throw new Error('mode must be baseline, verify, or timing');
const outputDir = '.omp/evidence/rust-import-performance-memory';
const timingLabel = process.argv[3] ?? 'before';
if (!['before', 'after'].includes(timingLabel)) throw new Error('timing label must be before or after');
const timingResults: Record<string, unknown> = {};

for (const [gameId, fixture] of fixtures) {
  const bytes = await Bun.file(`test/artifacts/sessions/${fixture}`).bytes();
  const child = spawn(resolve('native/recorder/target/release/raceiq-recorder'), ['--benchmark-stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const childError = new Promise<Error>(resolveError => child.once('error', resolveError));
  const request = JSON.stringify({ gameId, bytesBase64: Buffer.from(bytes).toString('base64') }) + '\n';
  const importOnce = async (): Promise<Reply> => {
    const response = new Promise<{ line: string }>(resolveLine => lines.once('line', line => resolveLine({ line })));
    child.stdin.write(request);
    const outcome = await Promise.race([response, childError.then(error => ({ error }))]);
    if ('error' in outcome) throw outcome.error;
    const reply: Reply = JSON.parse(outcome.line);
    if (reply.error) throw new Error(`${fixture}: ${reply.error}`);
    return reply;
  };

  if (mode === 'timing') {
    const times: number[] = [];
    for (let trial = 0; trial <= 20; trial++) {
      const reply = await importOnce();
      if (trial > 0) times.push(reply.elapsedSeconds);
    }
    const sorted = [...times].sort((a, b) => a - b);
    timingResults[gameId] = { fixture, warmups: 1, measuredTrials: times.length, times, median: (sorted[9] + sorted[10]) / 2 };
    console.log(JSON.stringify({ gameId, fixture, warmups: 1, measuredTrials: times.length, median: (sorted[9] + sorted[10]) / 2 }));
  } else {
    const reply = await importOnce();
    const normalized = normalize(reply.result);
    const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const baselinePath = `${outputDir}/${gameId}-baseline-result.json`;
    if (mode === 'baseline') {
      await Bun.write(baselinePath, JSON.stringify(normalized));
    } else {
      const baseline = await Bun.file(baselinePath).json();
      if (JSON.stringify(normalize(baseline)) !== JSON.stringify(normalized)) throw new Error(`${gameId}: complete normalized result mismatch`);
      await Bun.write(`${outputDir}/${gameId}-after-result.json`, JSON.stringify(normalized));
    }
    console.log(JSON.stringify({ gameId, fixture, digest, packetCount: packetCount(reply.result), elapsedSeconds: reply.elapsedSeconds, semanticParity: mode === 'verify' ? 'passed' : undefined }));
  }

  child.stdin.end();
  lines.close();
}

if (mode === 'timing') await Bun.write(`${outputDir}/native-${timingLabel}-timing.json`, JSON.stringify({ mode: timingLabel, binary: 'native/recorder/target/release/raceiq-recorder', warmupsPerFixture: 1, measuredTrialsPerFixture: 20, cases: timingResults }, null, 2));
