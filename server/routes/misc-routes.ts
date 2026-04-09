import { Hono } from "hono";
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "fs";
import { resolve, join } from "path";
import { arch, platform, release, type as osType, cpus, networkInterfaces, totalmem, freemem, uptime as osUptime } from "os";
import { zipSync, strToU8 } from "fflate";

import { lapDetector } from "../lap-detector";
import { wsManager } from "../ws";
import { USER_TRACKS_DIR, IS_COMPILED, USER_DATA_DIR, ROOT_DIR } from "../paths";
import { getUpdateState, startUpdateCheckSchedule, checkForUpdate, applyUpdate } from "../update-check";
import { udpListener } from "../udp";
import { getRunningGame } from "../games/registry";
import { getCurrentDetectedGame } from "../parsers";
import { loadSettings } from "../settings";
import { client as dbClient } from "../db";
import { getChatMemory } from "../ai/chat-agent";
import pkg from "../../package.json";

// Check for updates on startup and then every 4 hours
startUpdateCheckSchedule();
import {
  findForzaInstall,
  parseForzaZip,
  decompressForzaLZX,
} from "../../shared/lib/forza-lzx";
import { scanRecordedFiles } from "../../shared/track-data";

// ---------------------------------------------------------------------------
// FM2023 extraction state
// ---------------------------------------------------------------------------

const FM2023_OUT_DIR = resolve(USER_TRACKS_DIR, "fm-2023/extracted");

const extractionState = {
  status: "idle" as "idle" | "running" | "done" | "error",
  installed: !!findForzaInstall(),
  extracted: 0,
  failed: 0,
  total: 0,
  current: "",
  error: "",
};

// Check if already extracted on startup
try {
  if (existsSync(FM2023_OUT_DIR)) {
    const csvs = readdirSync(FM2023_OUT_DIR).filter(
      (f) => f.startsWith("recorded-") && f.endsWith(".csv"),
    );
    if (csvs.length > 0) {
      extractionState.status = "done";
      extractionState.extracted = csvs.length;
    }
  }
} catch {}

// ---------------------------------------------------------------------------
// FM2023 extraction helpers
// ---------------------------------------------------------------------------

function parseMlpWaypoints(
  data: Buffer,
): { x: number[]; z: number[] } | null {
  const text = data.toString("utf8", 0, Math.min(1024, data.length));
  const startIdx = text.indexOf("MLPDataStart:");
  if (startIdx === -1) return null;

  const headerEnd = text.indexOf("MLPDataEnd:");
  const header = text.substring(
    startIdx + "MLPDataStart:\n".length,
    headerEnd > 0 ? headerEnd : 1024,
  );

  let wpXOffset = -1,
    wpYOffset = -1,
    count = 0;

  for (const line of header.split("\n")) {
    const m = line.trim().match(/^(\w+):(\w+):(\d+):(\d+):\s+(\d+)$/);
    if (!m) continue;
    if (m[1] === "fWaypointX") {
      wpXOffset = parseInt(m[5]);
      count = parseInt(m[3]);
    }
    if (m[1] === "fWaypointY") wpYOffset = parseInt(m[5]);
  }

  if (wpXOffset < 0 || wpYOffset < 0 || count === 0) return null;

  const needed = Math.max(wpXOffset, wpYOffset) + count * 4;
  if (data.length < needed) {
    count = Math.min(
      Math.floor((data.length - wpXOffset) / 4),
      Math.floor((data.length - wpYOffset) / 4),
    );
    if (count < 50) return null;
  }

  const x: number[] = [],
    z: number[] = [];
  for (let i = 0; i < count; i++) {
    x.push(data.readFloatLE(wpXOffset + i * 4));
    z.push(data.readFloatLE(wpYOffset + i * 4));
  }
  return { x, z };
}

async function runExtraction() {
  const forzaDir = findForzaInstall();
  if (!forzaDir) {
    extractionState.status = "error";
    extractionState.error = "Forza Motorsport 2023 not found";
    return;
  }

  extractionState.status = "running";
  extractionState.extracted = 0;
  extractionState.failed = 0;
  extractionState.error = "";

  try {
    const { entries: trackEntries } = parseForzaZip(
      `${forzaDir}/media/base/ai/tracks.zip`,
    );

    const ordinalMap = new Map<string, number[]>();
    for (const entry of trackEntries) {
      const match = entry.name.match(
        /^(\w+)\/(ribbon_\d+)\/difficulty\/track_(\d+)_/,
      );
      if (match) {
        const key = `${match[1]}/${match[2]}`;
        const ordinal = parseInt(match[3], 10);
        if (!ordinalMap.has(key)) ordinalMap.set(key, []);
        const ords = ordinalMap.get(key)!;
        if (!ords.includes(ordinal)) ords.push(ordinal);
      }
    }

    mkdirSync(FM2023_OUT_DIR, { recursive: true });

    const tracksDir = `${forzaDir}/media/pcfamily/tracks`;
    const trackDirs = readdirSync(tracksDir).filter((d) =>
      existsSync(resolve(tracksDir, d, "ribbon_00.zip")),
    );

    const allRibbons: { trackDir: string; ribbonFile: string }[] = [];
    for (const trackDir of trackDirs) {
      const ribbons = readdirSync(resolve(tracksDir, trackDir)).filter((f) =>
        /^ribbon_\d+\.zip$/.test(f),
      );
      for (const r of ribbons) allRibbons.push({ trackDir, ribbonFile: r });
    }

    extractionState.total = allRibbons.length;

    for (const { trackDir, ribbonFile } of allRibbons) {
      const ribbonName = ribbonFile.replace(".zip", "");
      const mapKey = `${trackDir}/${ribbonName}`;
      extractionState.current = `${trackDir}/${ribbonName}`;

      const ordinals = ordinalMap.get(mapKey);
      if (!ordinals || ordinals.length === 0) continue;

      try {
        const { buf, entries } = parseForzaZip(
          resolve(tracksDir, trackDir, ribbonFile),
        );
        const geoEntry = entries.find((e) => e.name === "AI/Track.geo");
        if (!geoEntry) continue;

        const compressed = buf.subarray(
          geoEntry.dataStart,
          geoEntry.dataStart + geoEntry.compSize,
        );
        const decompressed = decompressForzaLZX(
          compressed,
          geoEntry.uncompSize,
        );
        const waypoints = parseMlpWaypoints(decompressed);
        if (!waypoints) {
          extractionState.failed++;
          continue;
        }

        for (const ordinal of ordinals) {
          const csv =
            "x,z\n" +
            waypoints.x
              .map((x, i) => `${x.toFixed(4)},${waypoints.z[i].toFixed(4)}`)
              .join("\n");
          writeFileSync(
            resolve(FM2023_OUT_DIR, `recorded-${ordinal}.csv`),
            csv,
          );
          extractionState.extracted++;
        }
      } catch {
        extractionState.failed++;
      }

      await new Promise((r) => setTimeout(r, 0));
    }

    extractionState.status = "done";
    extractionState.current = "";
    scanRecordedFiles();
  } catch (e: any) {
    extractionState.status = "error";
    extractionState.error = e.message || "Unknown error";
  }
}

// ---------------------------------------------------------------------------
// F1 2025 extraction state
// ---------------------------------------------------------------------------

const F1_25_OUT_DIR = resolve(USER_TRACKS_DIR, "f1-2025/extracted");

function findF1Install(): string | null {
  const vdfPath =
    "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf";
  if (!existsSync(vdfPath)) return null;
  try {
    const content = readFileSync(vdfPath, "utf8");
    const pathRegex = /"path"\s+"([^"]+)"/g;
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const libPath = match[1].replace(/\\\\/g, "/").replace(/\\/g, "/");
      const f1Path = `${libPath}/steamapps/common/F1 25`;
      if (existsSync(f1Path)) return f1Path;
    }
  } catch {}
  return null;
}

const f1ExtractionState = {
  status: "idle" as "idle" | "running" | "done" | "error",
  installed: !!findF1Install(),
  extracted: 0,
  failed: 0,
  total: 28,
  current: "",
  error: "",
};

try {
  if (existsSync(F1_25_OUT_DIR)) {
    const csvs = readdirSync(F1_25_OUT_DIR).filter(
      (f) => f.startsWith("recorded-") && f.endsWith(".csv"),
    );
    if (csvs.length > 0) {
      f1ExtractionState.status = "done";
      f1ExtractionState.extracted = csvs.length;
    }
  }
} catch {}

async function runF1Extraction() {
  if (!findF1Install()) {
    f1ExtractionState.status = "error";
    f1ExtractionState.error = "F1 25 not found";
    return;
  }

  f1ExtractionState.status = "running";
  f1ExtractionState.extracted = 0;
  f1ExtractionState.failed = 0;
  f1ExtractionState.error = "";
  f1ExtractionState.current = "Starting...";

  try {
    const { extractF1Tracks } = await import("../games/f1-2025/extract-tracks");
    const result = await extractF1Tracks(F1_25_OUT_DIR, (progress) => {
      if (progress.type === "extracted") {
        f1ExtractionState.extracted++;
        f1ExtractionState.current = progress.track;
      } else if (progress.type === "skipped") {
        f1ExtractionState.failed++;
      } else if (progress.type === "total") {
        f1ExtractionState.total = progress.count;
      }
    });

    f1ExtractionState.status = "done";
    f1ExtractionState.current = "";
    f1ExtractionState.extracted = result.extracted;
    scanRecordedFiles();
  } catch (e: any) {
    f1ExtractionState.status = "error";
    f1ExtractionState.error = e.message || "Unknown error";
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const miscRoutes = new Hono()
  // GET /api/version — current version + update availability
  .get("/api/version", (c) => {
    return c.json(getUpdateState());
  })

  // POST /api/update/check — force a fresh update check and return result
  .post("/api/update/check", async (c) => {
    const result = await checkForUpdate();
    return c.json(result);
  })

  // POST /api/update/apply — download and apply the pending update, then restart
  .post("/api/update/apply", async (c) => {
    try {
      await applyUpdate(); // starts download, spawns swap script, then process exits
      return new Response(null, { status: 204 });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  })

  // GET /api/fuel-history
  .get("/api/fuel-history", (c) => {
    return c.json(lapDetector.fuelHistory);
  })

  // GET /api/tire-wear-history
  .get("/api/tire-wear-history", (c) => {
    return c.json(lapDetector.tireWearHistory);
  })

  // GET /api/grip-history
  .get("/api/grip-history", (c) => {
    return c.json(wsManager.getGripHistory());
  })

  // GET /api/telemetry-history
  .get("/api/telemetry-history", (c) => {
    return c.json(wsManager.getTelemetryHistory());
  })

  // GET /api/games/detection — combined game detection status
  .get("/api/games/detection", (c) => {
    return c.json({
      "fm-2023": {
        installed: extractionState.installed,
        extracted:
          extractionState.status === "done" && extractionState.extracted > 0,
        extractionStatus: extractionState.status,
        trackCount: extractionState.extracted,
      },
      "f1-2025": {
        installed: f1ExtractionState.installed,
        extracted:
          f1ExtractionState.status === "done" &&
          f1ExtractionState.extracted > 0,
        extractionStatus: f1ExtractionState.status,
        trackCount: f1ExtractionState.extracted,
      },
    });
  })

  // GET /api/extraction/status — FM2023 extraction status
  .get("/api/extraction/status", (c) => {
    return c.json(extractionState);
  })

  // POST /api/extraction/run — start FM2023 extraction
  .post("/api/extraction/run", async (c) => {
    if (extractionState.status === "running")
      return c.json({ error: "Extraction already in progress" }, 409);
    runExtraction();
    return c.json({ started: true });
  })

  // DELETE /api/extraction/data — delete FM2023 extracted data
  .delete("/api/extraction/data", (c) => {
    if (extractionState.status === "running")
      return c.json({ error: "Extraction in progress" }, 409);
    if (existsSync(FM2023_OUT_DIR)) {
      rmSync(FM2023_OUT_DIR, { recursive: true, force: true });
      mkdirSync(FM2023_OUT_DIR, { recursive: true });
    }
    extractionState.status = "idle";
    extractionState.extracted = 0;
    extractionState.failed = 0;
    scanRecordedFiles();
    return c.json({ deleted: true });
  })

  // GET /api/extraction/f1/status — F1 extraction status
  .get("/api/extraction/f1/status", (c) => {
    return c.json(f1ExtractionState);
  })

  // POST /api/extraction/f1/run — start F1 extraction
  .post("/api/extraction/f1/run", async (c) => {
    if (f1ExtractionState.status === "running")
      return c.json({ error: "Extraction already in progress" }, 409);
    runF1Extraction();
    return c.json({ started: true });
  })

  // DELETE /api/extraction/f1/data — delete F1 extracted data
  .delete("/api/extraction/f1/data", (c) => {
    if (f1ExtractionState.status === "running")
      return c.json({ error: "Extraction in progress" }, 409);
    if (existsSync(F1_25_OUT_DIR)) {
      rmSync(F1_25_OUT_DIR, { recursive: true, force: true });
      mkdirSync(F1_25_OUT_DIR, { recursive: true });
    }
    f1ExtractionState.status = "idle";
    f1ExtractionState.extracted = 0;
    f1ExtractionState.failed = 0;
    scanRecordedFiles();
    return c.json({ deleted: true });
  })

  // GET /api/diagnostics — download a zip with diagnostics.json + logs.txt
  .get("/api/diagnostics", async (c) => {
    const logFile = join(USER_DATA_DIR, "raceiq.log");
    let logs = "";
    try {
      logs = readFileSync(logFile, "utf8");
    } catch {}

    const session = lapDetector.session;
    // Detect game from actual UDP packets being parsed, then fall back to process list
    let runningGame = getCurrentDetectedGame();
    if (!runningGame) {
      runningGame = getRunningGame();
    }
    const settings = loadSettings();

    // Browser details from query parameters
    const browserName = c.req.query("browserName") || "Unknown";
    const browserVersion = c.req.query("browserVersion") || "Unknown";
    const browserEngine = c.req.query("browserEngine") || "Unknown";
    const browserUA = c.req.query("browserUA") || "";

    // Browser memory usage (if available)
    let browserMemoryMB: number | null = null;
    const browserMemoryStr = c.req.query("browserMemory");
    if (browserMemoryStr) {
      const parsed = parseFloat(browserMemoryStr);
      if (!isNaN(parsed)) browserMemoryMB = parsed;
    }

    // Server process memory usage
    const memUsage = process.memoryUsage();
    const serverMemoryMB = Math.round(memUsage.heapUsed / 1024 / 1024);

    // Fetch recent chat messages from Mastra memory
    let chatMessages: Array<{ role: string; content: string; timestamp?: string }> = [];
    try {
      // Note: Mastra Memory API varies by version. Attempt to fetch threads if available.
      const memory = getChatMemory();
      if (memory && typeof (memory as any).getThreads === "function") {
        const threads = await (memory as any).getThreads();
        if (threads && threads.length > 0) {
          for (const thread of threads.slice(0, 5)) {
            if (typeof (memory as any).getMessages === "function") {
              const messages = await (memory as any).getMessages(thread.id);
              if (messages) {
                chatMessages.push(
                  ...messages.map((m: any) => ({
                    role: m.role || "unknown",
                    content: m.content || "",
                    timestamp: m.createdAt || m.timestamp,
                  }))
                );
              }
            }
          }
        }
      }
    } catch {}

    // Database size and stats
    let dbSizeMB: number | null = null;
    let sessionCount: number | null = null;
    let lapCount: number | null = null;
    try {
      const dbPath = join(USER_DATA_DIR, "forza-telemetry.db");
      if (existsSync(dbPath)) {
        const stats = statSync(dbPath);
        dbSizeMB = Math.round(stats.size / 1024 / 1024 * 100) / 100;
      }
      // Query session and lap counts
      const sessionResult = await dbClient.execute("SELECT COUNT(*) as count FROM sessions");
      sessionCount = Number(sessionResult.rows[0]?.count) || 0;
      const lapResult = await dbClient.execute("SELECT COUNT(*) as count FROM laps");
      lapCount = Number(lapResult.rows[0]?.count) || 0;
    } catch {}


    // Hardware & network diagnostics (Windows — all via PowerShell)
    let cpuUsagePercent: number | null = null;
    let gpuName: string | null = null;
    let gpuUsagePercent: number | null = null;
    let networkType: string | null = null;
    let linkSpeedMbps: number | null = null;

    // Detect network type from OS network interfaces as fallback
    const nets = networkInterfaces();
    for (const [name, addrs] of Object.entries(nets)) {
      const active = addrs?.find((a) => !a.internal && a.family === "IPv4");
      if (active) {
        const lower = name.toLowerCase();
        networkType = lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wlan")
          ? "WiFi" : "Ethernet";
        break;
      }
    }

    if (platform() === "win32") {
      const ps = (cmd: string) => {
        try {
          const proc = Bun.spawnSync(["powershell", "-NoProfile", "-Command", cmd]);
          return proc.stdout.toString().trim();
        } catch { return ""; }
      };

      // CPU usage
      const cpuOut = ps("(Get-CimInstance Win32_Processor).LoadPercentage");
      const cpuPct = parseInt(cpuOut, 10);
      if (!isNaN(cpuPct)) cpuUsagePercent = cpuPct;

      // GPU name (first discrete GPU, skip integrated)
      const gpuOut = ps("Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name");
      if (gpuOut) {
        const gpus = gpuOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        gpuName = gpus.find((g) => !(/integrated|radeon.*graphics$/i.test(g))) ?? gpus[0] ?? null;
      }

      // GPU usage — try nvidia-smi, fall back to perf counter
      const nvOut = ps("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits");
      const nvPct = parseInt(nvOut, 10);
      if (!isNaN(nvPct)) {
        gpuUsagePercent = nvPct;
      } else {
        const counterOut = ps("(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage').CounterSamples | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum");
        const cPct = Math.round(parseFloat(counterOut));
        if (!isNaN(cPct)) gpuUsagePercent = cPct;
      }

      // Network adapter name + link speed
      const netOut = ps("Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Select-Object -First 1 Name,LinkSpeed | Format-List");
      const netNameMatch = netOut.match(/Name\s*:\s*(.+)/);
      if (netNameMatch) {
        const n = netNameMatch[1].trim().toLowerCase();
        networkType = n.includes("wi-fi") || n.includes("wifi") || n.includes("wireless")
          ? "WiFi" : "Ethernet";
      }
      const linkMatch = netOut.match(/LinkSpeed\s*:\s*(.+)/);
      if (linkMatch) {
        const raw = linkMatch[1].trim();
        const m = raw.match(/([\d.]+)\s*(Gbps|Mbps)/i);
        if (m) linkSpeedMbps = m[2].toLowerCase() === "gbps" ? Math.round(parseFloat(m[1]) * 1000) : Math.round(parseFloat(m[1]));
      }
    }

    // Power mode
    let powerMode: string | null = null;
    if (platform() === "win32") {
      const ps = (cmd: string) => {
        try {
          const proc = Bun.spawnSync(["powershell", "-NoProfile", "-Command", cmd]);
          return proc.stdout.toString().trim();
        } catch { return ""; }
      };

      const powerOut = ps("powercfg /getactivescheme");
      // Output format: "GUID: {guid}  (Scheme Name)"
      const schemeMatch = powerOut.match(/\(([^)]+)\)\s*$/);
      if (schemeMatch) {
        powerMode = schemeMatch[1].trim();
      }
    }

    // Drive types for install and data directories
    let installDriveType: string | null = null;
    let dataDriveType: string | null = null;
    if (platform() === "win32") {
      const driveType = (dir: string) => {
        try {
          const proc = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
            `try{$dl=([System.IO.Path]::GetPathRoot('${dir.replace(/'/g, "''")}'))[0];$p=Get-Partition -DriveLetter $dl -ErrorAction Stop;$d=Get-PhysicalDisk -DeviceNumber $p.DiskNumber -ErrorAction Stop;$d.MediaType}catch{'Unknown'}`]);
          return proc.stdout.toString().trim() || null;
        } catch { return null; }
      };
      installDriveType = driveType(ROOT_DIR);
      dataDriveType = driveType(USER_DATA_DIR);
    }

    const diagnostics = {
      app: {
        version: pkg.version,
        compiled: IS_COMPILED,
        installDir: ROOT_DIR,
        installDriveType,
        dataDir: USER_DATA_DIR,
        dataDriveType,
        bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
      },
      browser: {
        name: browserName,
        version: browserVersion,
        engine: browserEngine,
        userAgent: browserUA,
        memoryUsedMB: browserMemoryMB,
      },
      system: {
        os: osType(),
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        powerMode,
        cpu: cpus()[0]?.model ?? null,
        cpuCores: cpus().length,
        cpuUsagePercent,
        gpu: gpuName,
        gpuUsagePercent,
        network: networkType,
        linkSpeedMbps,
        totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
        freeMemoryMB: Math.round(freemem() / 1024 / 1024),
        uptimeSec: Math.round(osUptime()),
      },
      server: {
        udpPort: udpListener.port,
        udpReceiving: udpListener.receiving,
        packetsPerSec: udpListener.packetsPerSec,
        droppedPackets: udpListener.droppedPackets,
        connectedClients: wsManager.connectedClients,
        memoryHeapUsedMB: serverMemoryMB,
        database: {
          sizeMB: dbSizeMB,
          sessionCount,
          lapCount,
        },
        detectedGame: runningGame
          ? { id: runningGame.id, name: runningGame.shortName }
          : null,
        currentSession: session
          ? { id: session.sessionId, car: session.carOrdinal, track: session.trackOrdinal }
          : null,
      },
      settings: {
        udpPort: settings.udpPort,
        unit: settings.unit,
        wsRefreshRate: settings.wsRefreshRate,
        aiAnalysis: {
          provider: settings.aiProvider,
          model: settings.aiModel,
        },
        aiChat: {
          provider: settings.chatProvider,
          model: settings.chatModel,
        },
      },
      chat: {
        messageCount: chatMessages.length,
        recentMessages: chatMessages.slice(0, 20),
      },
      generatedAt: new Date().toISOString(),
    };

    const zip = zipSync({
      "diagnostics.json": strToU8(JSON.stringify(diagnostics, null, 2)),
      "logs.txt": strToU8(logs),
    });

    return new Response(Buffer.from(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="raceiq-diagnostics.zip"`,
      },
    });
  });
