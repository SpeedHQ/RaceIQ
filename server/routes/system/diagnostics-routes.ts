import { existsSync, statSync } from "fs";
import { join } from "path";
import { arch, platform, release, type as osType, cpus, networkInterfaces, totalmem, freemem, uptime as osUptime } from "os";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { zipSync, strToU8 } from "fflate";

import { lapDetector } from "../../pipeline";
import { wsManager } from "../../ws";
import { IS_COMPILED, USER_DATA_DIR, ROOT_DIR } from "../../paths";
import { udpListener } from "../../udp";
import { getRunningGame } from "../../games/registry";
import { getCurrentDetectedGame } from "../../parsers";
import { loadSettings } from "../../settings";
import { client as dbClient } from "../../db";
import { getChatMemory, CHAT_RESOURCE_ID } from "../../ai/chat-agent";
import { log, readRecentLogText } from "../../logger";
import pkg from "../../../package.json";

const ClientLogSchema = z.object({
  level: z.enum(["warn", "error"]).default("error"),
  scope: z.string().max(64),
  message: z.string().max(4000),
  detail: z.unknown().optional(),
});

export const diagnosticsRoutes = new Hono()
  /**
   * POST /api/client-log — sink for browser-side errors.
   *
   * The file logger only captures the server console, so anything thrown in the
   * React AI panels stays in devtools and never reaches the diagnostics export.
   * The client posts here so user-reported chat failures are in `logs.txt`.
   */
  .post("/api/client-log", zValidator("json", ClientLogSchema), async (c) => {
    const { level, scope, message, detail } = c.req.valid("json");
    const suffix = detail ? ` ${JSON.stringify(detail).slice(0, 2000)}` : "";
    const line = `[Client/${scope}] ${message}${suffix}`;
    if (level === "warn") log.warn(line);
    else log.error(line);
    return c.json({ ok: true });
  })

  // GET /api/diagnostics — download a zip with diagnostics.json + logs.txt
  .get("/api/diagnostics", async (c) => {
    const logs = readRecentLogText();

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

    // Chat metadata from Mastra memory (newest threads first). Message *text*
    // is deliberately excluded — a diagnostics zip gets attached to bug reports
    // and shared around, and the conversation itself is the user's, not ours.
    // Counts + thread ids answer "was chat used, how much, on which laps",
    // which is what support actually needs; failures are in `logs.txt`.
    const chatThreads: Array<{ threadId: string; messages: number; updatedAt: string }> = [];
    let chatMessageCount = 0;
    let chatError: string | null = null;
    try {
      const memory = getChatMemory();
      const { threads } = await memory.listThreads({
        filter: { resourceId: CHAT_RESOURCE_ID },
        perPage: false,
      });
      const toIso = (v: unknown) =>
        v instanceof Date ? v.toISOString() : v ? String(v) : "";
      const recent = [...threads]
        .sort((a, b) => toIso(b.updatedAt).localeCompare(toIso(a.updatedAt)))
        .slice(0, 5);
      for (const thread of recent) {
        const result = await memory.recall({ threadId: thread.id });
        const count = (result.messages ?? []).filter(
          (m) => m.role === "user" || m.role === "assistant",
        ).length;
        chatMessageCount += count;
        chatThreads.push({
          threadId: thread.id,
          messages: count,
          updatedAt: toIso(thread.updatedAt),
        });
      }
    } catch (err: any) {
      chatError = err?.message ?? String(err);
      console.error("[Diagnostics] Failed to read chat memory:", chatError);
    }

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
        messageCount: chatMessageCount,
        error: chatError,
        threads: chatThreads,
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
