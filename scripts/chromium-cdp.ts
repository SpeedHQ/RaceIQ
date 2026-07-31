import { Buffer } from "node:buffer";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import type { StorybookSnapshotCase } from "../client/src/stories/snapshot-cases";

interface ViewportCase {
  name: string;
  width: number;
  height: number;
}

interface PageCase {
  name: string;
  path: string;
}

interface InteractionCase extends PageCase {
  kind: "nav-drawer" | "settings";
  mobileOnly: boolean;
}

export interface ResponsiveCdpCaptureOptions {
  clientUrl: string;
  screenshotDir: string;
  debuggingPort: number;
  viewports: readonly ViewportCase[];
  pages: readonly PageCase[];
  interactions: readonly InteractionCase[];
}

export interface StorybookCdpCaptureOptions {
  storybookUrl: string;
  screenshotDir: string;
  debuggingPort: number;
  cases: readonly StorybookSnapshotCase[];
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly waiters = new Map<string, EventWaiter[]>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) {
          call.reject(new Error(message.error.message ?? "CDP command failed"));
        } else {
          call.resolve(message.result);
        }
        return;
      }
      if (!message.method) return;
      const eventWaiters = this.waiters.get(message.method);
      if (!eventWaiters?.length) return;
      this.waiters.delete(message.method);
      for (const waiter of eventWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(message.params);
      }
    });
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out connecting to Chromium CDP")),
        10_000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Chromium CDP WebSocket failed"));
        },
        { once: true },
      );
    });
    return new CdpSession(socket);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent<T = unknown>(method: string, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: EventWaiter = {
        resolve: (value) => resolve(value as T),
        reject,
        timer: setTimeout(() => {
          const current = this.waiters.get(method) ?? [];
          this.waiters.set(
            method,
            current.filter((candidate) => candidate !== waiter),
          );
          reject(new Error(`CDP event timed out: ${method}`));
        }, timeoutMs),
      };
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), waiter]);
    });
  }

  close(): void {
    this.socket.close();
  }
}

type SpawnedProcess = ReturnType<typeof Bun.spawn>;

async function stopProcessTree(subprocess: SpawnedProcess): Promise<void> {
  if (subprocess.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = Bun.spawn(
      ["taskkill", "/PID", String(subprocess.pid), "/T", "/F"],
      { stdout: "ignore", stderr: "ignore" },
    );
    await killer.exited;
    return;
  }
  subprocess.kill("SIGTERM");
  const stopped = await Promise.race([
    subprocess.exited.then(() => true),
    Bun.sleep(10_000).then(() => false),
  ]);
  if (!stopped) {
    subprocess.kill("SIGKILL");
    await subprocess.exited;
  }
}

async function waitForPageTarget(port: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = (await response.json()) as Array<{
          type: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (target) => target.type === "page" && target.webSocketDebuggerUrl,
        );
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
      lastError = new Error(`Chromium target list returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out waiting for Chromium CDP page: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function navigate(session: CdpSession, url: string): Promise<void> {
  const loaded = session.waitForEvent("Page.loadEventFired", 60_000);
  await session.send("Page.navigate", { url }, 60_000);
  await loaded;
  await session.send(
    "Runtime.evaluate",
    {
      expression: "document.fonts.ready",
      awaitPromise: true,
      returnByValue: true,
    },
    30_000,
  );
  await session.send("Runtime.evaluate", {
    expression: `(() => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}";
      document.head.appendChild(style);
    })()`,
  });
  await Bun.sleep(750);
}

async function evaluateBoolean(
  session: CdpSession,
  expression: string,
): Promise<boolean> {
  const response = await session.send<{
    result?: { value?: boolean };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(`Browser expression failed: ${expression}`);
  }
  return response.result?.value === true;
}

async function evaluateValue<T>(
  session: CdpSession,
  expression: string,
  awaitPromise = false,
): Promise<T | undefined> {
  const response = await session.send<{
    result?: { value?: T };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(`Browser expression failed: ${expression}`);
  }
  return response.result?.value;
}

async function waitForExpression(
  session: CdpSession,
  expression: string,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluateBoolean(session, expression)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickExpression(
  session: CdpSession,
  expression: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await evaluateBoolean(session, expression)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Could not find ${label}`);
}

async function saveScreenshot(
  session: CdpSession,
  outputPath: string,
  fullPage: boolean,
): Promise<void> {
  mkdirSync(dirname(outputPath), { recursive: true });
  const params: Record<string, unknown> = {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: fullPage,
  };
  if (fullPage) {
    const metrics = await session.send<{
      cssContentSize: { x: number; y: number; width: number; height: number };
    }>("Page.getLayoutMetrics");
    params.clip = {
      x: metrics.cssContentSize.x,
      y: metrics.cssContentSize.y,
      width: Math.ceil(metrics.cssContentSize.width),
      height: Math.ceil(metrics.cssContentSize.height),
      scale: 1,
    };
  }
  const result = await session.send<{ data: string }>(
    "Page.captureScreenshot",
    params,
    60_000,
  );
  await Bun.write(outputPath, Buffer.from(result.data, "base64"));
}

export async function captureResponsiveWithCdp(
  options: ResponsiveCdpCaptureOptions,
): Promise<void> {
  const profileDir = mkdtempSync(join(tmpdir(), "raceiq-ui-diff-chromium-"));
  const chrome = Bun.spawn(
    [
      chromium.executablePath(),
      "--headless=new",
      `--remote-debugging-port=${options.debuggingPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      "--enable-unsafe-swiftshader",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let session: CdpSession | null = null;

  try {
    session = await CdpSession.connect(
      await waitForPageTarget(options.debuggingPort),
    );
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });

    for (const viewport of options.viewports) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      });

      for (const screenshotCase of options.pages) {
        console.log(`Capturing ${viewport.name}/${screenshotCase.name}`);
        await navigate(session, `${options.clientUrl}${screenshotCase.path}`);
        await saveScreenshot(
          session,
          join(
            options.screenshotDir,
            viewport.name,
            `${screenshotCase.name}.png`,
          ),
          true,
        );
      }

      for (const screenshotCase of options.interactions) {
        if (screenshotCase.mobileOnly && viewport.width >= 768) continue;

        console.log(`Capturing ${viewport.name}/${screenshotCase.name}`);
        await navigate(
          session,
          `${options.clientUrl}${screenshotCase.path}`,
        );
        if (
          screenshotCase.kind === "nav-drawer" ||
          viewport.width < 768
        ) {
          await clickExpression(
            session,
            `(() => {
              const element = document.querySelector('[aria-label="Open navigation"]');
              if (!element || typeof element.click !== "function") return false;
              element.click();
              return true;
            })()`,
            "Open navigation button",
          );
        }
        if (screenshotCase.kind === "nav-drawer") {
          await waitForExpression(
            session,
            `document.querySelectorAll("nav").length > 1`,
            "navigation drawer",
          );
        } else {
          await clickExpression(
            session,
            `(() => {
              const buttons = [...document.querySelectorAll("button")];
              const element = buttons.find((button) =>
                /Settings|TestDriver/.test(button.textContent ?? "") ||
                /Settings/.test(button.getAttribute("aria-label") ?? "")
              );
              if (!element || typeof element.click !== "function") return false;
              element.click();
              return true;
            })()`,
            "Settings button",
          );
          await waitForExpression(
            session,
            `[...document.querySelectorAll("h1,h2,h3,h4")].some((heading) => heading.textContent?.trim() === "Settings")`,
            "Settings modal",
          );
        }
        await Bun.sleep(200);
        await saveScreenshot(
          session,
          join(
            options.screenshotDir,
            viewport.name,
            `${screenshotCase.name}.png`,
          ),
          false,
        );
      }
    }
  } finally {
    session?.close();
    await stopProcessTree(chrome);
    await Bun.sleep(1_000);
    try {
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (error) {
      console.warn(
        `Could not remove Chromium profile ${profileDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function navigateToStory(
  session: CdpSession,
  url: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await navigate(session, url);
      await waitForExpression(
        session,
        `(() => {
          const element = document.querySelector("#storybook-root > *");
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })()`,
        "Storybook story content",
        10_000,
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Storybook story did not render: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function prepareStorySnapshot(
  session: CdpSession,
  story: StorybookSnapshotCase,
): Promise<void> {
  await evaluateValue(
    session,
    `(async () => {
      await document.fonts.ready;
      return true;
    })()`,
    true,
  );
  await waitForExpression(
    session,
    `(() => {
      const style = getComputedStyle(document.documentElement);
      return ["--app-bg", "--app-text", "--app-accent", "--font-sans", "--font-mono"]
        .every((token) => style.getPropertyValue(token).trim().length > 0);
    })()`,
    "Storybook theme tokens",
    60_000,
  );
  await waitForExpression(
    session,
    `Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0)`,
    "Storybook images",
    60_000,
  );
  await waitForExpression(
    session,
    `Array.from(document.querySelectorAll("[data-visual-ready]"))
      .every((element) => element.getAttribute("data-visual-ready") === "ready")`,
    "Storybook visual readiness",
    60_000,
  );

  if (story.readyText) {
    await waitForExpression(
      session,
      `document.body.innerText.includes(${JSON.stringify(story.readyText)})`,
      `${story.readyText} content`,
      60_000,
    );
  }
  if (story.hoverLabel) {
    const point = await evaluateValue<{ x: number; y: number }>(
      session,
      `(() => {
        const label = ${JSON.stringify(story.hoverLabel)};
        const element = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === label);
        if (!element) return undefined;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
    );
    if (!point) throw new Error(`Could not find ${story.hoverLabel} button`);
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
  }
  await Bun.sleep(300);
}

export async function captureStorybookWithCdp(
  options: StorybookCdpCaptureOptions,
): Promise<void> {
  const profileDir = mkdtempSync(
    join(tmpdir(), "raceiq-ui-diff-storybook-chromium-"),
  );
  const chrome = Bun.spawn(
    [
      chromium.executablePath(),
      "--headless=new",
      `--remote-debugging-port=${options.debuggingPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      "--enable-unsafe-swiftshader",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let session: CdpSession | null = null;

  try {
    session = await CdpSession.connect(
      await waitForPageTarget(options.debuggingPort),
    );
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    for (const story of options.cases) {
      const viewport = story.viewport ?? { width: 1920, height: 1080 };
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      });

      console.log(`Capturing storybook/${story.outputName}`);
      await navigateToStory(
        session,
        `${options.storybookUrl}/iframe.html?id=${story.id}&viewMode=story`,
      );
      await prepareStorySnapshot(session, story);
      await saveScreenshot(
        session,
        join(options.screenshotDir, story.outputName),
        false,
      );
    }
  } finally {
    session?.close();
    await stopProcessTree(chrome);
    await Bun.sleep(1_000);
    try {
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (error) {
      console.warn(
        `Could not remove Chromium profile ${profileDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
