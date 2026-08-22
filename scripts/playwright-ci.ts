#!/usr/bin/env bun

const runnerMemoryScript = `
$ErrorActionPreference = "Stop"
$memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$operatingSystem = Get-CimInstance Win32_OperatingSystem
$topProcesses = @(Get-Process -ErrorAction SilentlyContinue |
  Sort-Object PrivateMemorySize64 -Descending |
  Select-Object -First 8 |
  ForEach-Object {
    [ordered]@{
      name = $_.ProcessName
      pid = $_.Id
      privateMB = [math]::Round($_.PrivateMemorySize64 / 1MB, 1)
      workingSetMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
    }
  })
[ordered]@{
  timestamp = [DateTime]::UtcNow.ToString("o")
  label = $env:RACEIQ_MEMORY_SAMPLE_LABEL
  totalVisibleMemoryMB = [math]::Round($operatingSystem.TotalVisibleMemorySize / 1KB)
  availableMB = [int64]$memory.AvailableMBytes
  committedGB = [math]::Round($memory.CommittedBytes / 1GB, 2)
  commitLimitGB = [math]::Round($memory.CommitLimit / 1GB, 2)
  commitPercent = [int]$memory.PercentCommittedBytesInUse
  nonpagedPoolMB = [math]::Round($memory.PoolNonpagedBytes / 1MB, 1)
  pagedPoolMB = [math]::Round($memory.PoolPagedBytes / 1MB, 1)
  cacheMB = [math]::Round($memory.CacheBytes / 1MB, 1)
  pageTableMB = [math]::Round($memory.PageTableBytes / 1MB, 1)
  topProcesses = $topProcesses
} | ConvertTo-Json -Compress -Depth 4
`;

async function reportRunnerMemory(label: string): Promise<void> {
  if (process.platform !== "win32" || Bun.env.CI !== "true") return;
  try {
    const sampleProcess = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", runnerMemoryScript], {
      env: { ...Bun.env, RACEIQ_MEMORY_SAMPLE_LABEL: label },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        sampleProcess.kill();
      } catch {
        // Process exited between timeout scheduling and termination.
      }
    }, 5_000);
    timeout.unref();
    const [exitCode, stdout, stderr] = await Promise.all([
      sampleProcess.exited,
      new Response(sampleProcess.stdout).text(),
      new Response(sampleProcess.stderr).text(),
    ]).finally(() => clearTimeout(timeout));
    if (!timedOut && exitCode === 0 && stdout.trim()) {
      console.log(`[runner-memory] ${stdout.trim()}`);
      return;
    }
    const reason = timedOut ? "sample timed out after 5 seconds" : stderr.trim() || "no output";
    console.warn(`[runner-memory] sample failed (${exitCode}): ${reason}`);
  } catch (error) {
    console.warn(`[runner-memory] sample failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function startRunnerMemorySampling(scope: string): Promise<() => Promise<void>> {
  if (process.platform !== "win32" || Bun.env.CI !== "true") return async () => {};
  await reportRunnerMemory(`${scope}:start`);
  let pendingSample: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pendingSample) return;
    pendingSample = reportRunnerMemory(`${scope}:periodic`).finally(() => {
      pendingSample = undefined;
    });
  }, 30_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pendingSample;
    await reportRunnerMemory(`${scope}:end`);
  };
}

const [command, ...commandArgs] = Bun.argv.slice(2);
const projectArgs = (Bun.env.PLAYWRIGHT_PROJECTS ?? "").trim().split(/\s+/).filter(Boolean);

if (!command) {
  console.error("Usage: bun scripts/playwright-ci.ts <playwright-command> [args...]");
  process.exit(2);
}

const playwrightArgs = [command, ...commandArgs, ...projectArgs];
const playwrightCli = Bun.resolveSync("@playwright/test/cli", process.cwd());
const nodeExecutable = Bun.which("node");

if (!nodeExecutable) {
  console.error("Node.js executable not found; Playwright requires Node.js 20 or newer.");
  process.exit(2);
}

const stopRunnerMemorySampling = await startRunnerMemorySampling(`playwright-${command}`);

const child = Bun.spawn([nodeExecutable, playwrightCli, ...playwrightArgs], {
  cwd: process.cwd(),
  env: Bun.env,
  stdout: "pipe",
  stderr: "pipe",
});

const captureStdout = command === "test" && commandArgs.includes("--list");
const stdoutChunks: Uint8Array[] = [];

async function streamOutput(stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream, capture = false): Promise<void> {
  for await (const chunk of stream) {
    target.write(chunk);
    if (capture) stdoutChunks.push(chunk);
  }
}

const [exitCode] = await Promise.all([
  child.exited,
  streamOutput(child.stdout, process.stdout, captureStdout),
  streamOutput(child.stderr, process.stderr),
]);

const stdout = new TextDecoder().decode(Buffer.concat(stdoutChunks));
let finalExitCode = exitCode;

if (command === "test" && commandArgs.includes("--list")) {
  if (exitCode === 0 && !/Total:\s+[1-9]\d*\s+tests/.test(stdout)) {
    console.error(`No Playwright tests discovered for ${projectArgs.join(" ")}`);
    finalExitCode = 1;
  }
}

await stopRunnerMemorySampling();
process.exit(finalExitCode);
export {};
