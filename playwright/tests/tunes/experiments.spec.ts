import { expect, test } from "@playwright/test";
import { completeOnboarding } from "../support/tunes";

test.describe("Setup Engineer experiments", () => {
  test("shows setup-seeded v1 immediately after session creation", async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);

    const createResponse = await page.request.post("/api/experiments", {
      data: {
        gameId: "acc",
        name: "E2E setup-seeded experiment",
        carName: "e2e-car",
        trackName: "e2e-track",
        baseSetupPath: "fixtures/e2e-base.json",
        focus: "car",
      },
    });
    expect(createResponse.status()).toBe(201);
    const session = (await createResponse.json()) as {
      id: number;
      headVersionId: number | null;
    };

    const versionsResponse = await page.request.get(
      `/api/experiments/${session.id}/versions`,
    );
    expect(versionsResponse.ok()).toBeTruthy();
    const versions = (await versionsResponse.json()) as Array<{
      id: number;
      version: number;
      label: string;
      setupPath: string | null;
      kind: string;
    }>;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      label: "v1",
      setupPath: "fixtures/e2e-base.json",
      kind: "setup",
    });
    expect(versions[0]?.id).toBe(session.headVersionId);

    await page.goto(`/acc/experiments/${session.id}`);
    await expect(page.getByText("v1", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Setup", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("HEAD", { exact: true })).toBeVisible();
    await expect(page.getByText(/No setup versions yet/)).toHaveCount(0);
  });

  test("creates v1 for a new AC Evo setup experiment", async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);

    const createResponse = await page.request.post("/api/experiments", {
      data: {
        gameId: "ac-evo",
        name: "E2E AC Evo setup-seeded experiment",
        carName: "e2e-car",
        trackName: "e2e-track",
        baseSetupPath: "fixtures/e2e-base.carsetup",
        focus: "car",
      },
    });
    expect(createResponse.status()).toBe(201);
    const session = (await createResponse.json()) as {
      id: number;
      headVersionId: number | null;
    };

    const versionsResponse = await page.request.get(`/api/experiments/${session.id}/versions`);
    expect(versionsResponse.ok()).toBeTruthy();
    const versions = (await versionsResponse.json()) as Array<{
      version: number;
      label: string;
      setupPath: string | null;
      kind: string;
    }>;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      label: "v1",
      setupPath: "fixtures/e2e-base.carsetup",
      kind: "setup",
    });
    expect(versions[0]?.label).toBe("v1");
    expect(session.headVersionId).toBeGreaterThan(0);
  });

  test("API creation seeds v1 from selected ACC and AC Evo setups", async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);

    for (const gameId of ["acc", "ac-evo"] as const) {
      const setupFilesResponse = await page.request.get(`/api/tunes/setup-files?gameId=${gameId}`);
      expect(setupFilesResponse.ok(), `${gameId} setup catalog`).toBe(true);
      const setupFiles = (await setupFilesResponse.json()) as {
        files: Array<{ absolutePath: string }>;
      };
      expect(setupFiles.files.length, `${gameId} must expose a selectable setup`).toBeGreaterThan(0);

      const createResponse = await page.request.post("/api/experiments", {
        data: {
          gameId,
          name: `E2E ${gameId} API setup-seeded experiment`,
          carName: "e2e-car",
          trackName: "e2e-track",
          baseSetupPath: setupFiles.files[0]!.absolutePath,
          focus: "car",
        },
      });
      expect(createResponse.status(), `${gameId} create status`).toBe(201);
      const session = (await createResponse.json()) as { id: number; headVersionId: number | null };

      const versionsResponse = await page.request.get(`/api/experiments/${session.id}/versions`);
      expect(versionsResponse.ok()).toBe(true);
      const versions = (await versionsResponse.json()) as Array<{ id: number; version: number; label: string; setupPath: string | null; kind: string }>;
      expect(versions, `${gameId} versions`).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version: 1, label: "v1", setupPath: setupFiles.files[0]!.absolutePath, kind: "setup" });
      expect(session.headVersionId, `${gameId} HEAD`).toBe(versions[0]?.id);
    }
  });
  test("streams Race engineer reply before completion without reload", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      console.log(`[browser:${message.type()}] ${message.text()}`);
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      let releaseStream: (() => void) | undefined;
      let textSent = false;
      let releaseCalled = false;
      let streamResumed = false;
      let finalChunkSent = false;
      Object.defineProperty(window, "__raceTextSent", {
        configurable: true,
        get: () => textSent,
      });
      Object.defineProperty(window, "__raceReleased", {
        configurable: true,
        get: () => releaseCalled,
      });
      Object.defineProperty(window, "__releaseRaceEngineerStream", {
        configurable: true,
        writable: true,
        value: () => releaseStream?.(),
      });
      Object.defineProperty(window, "__raceStreamResumed", {
        configurable: true,
        get: () => streamResumed,
      });
      Object.defineProperty(window, "__raceFinalChunkSent", {
        configurable: true,
        get: () => finalChunkSent,
      });

      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || !new URL(request.url).pathname.match(/^\/api\/experiments\/\d+\/chat$/)) {
          return originalFetch(input, init);
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const write = (value: string) => controller.enqueue(encoder.encode(value));
            write('data: {"type":"start","messageId":"assistant-stream-test"}\n\n');
            write('data: {"type":"reasoning-start","id":"reasoning-1"}\n\n');
            write('data: {"type":"reasoning-delta","id":"reasoning-1","delta":"Thinking chunk"}\n\n');
            write('data: {"type":"reasoning-end","id":"reasoning-1"}\n\n');
            write('data: {"type":"tool-input-start","toolCallId":"tool-1","toolName":"preview_change"}\n\n');
            write('data: {"type":"tool-input-delta","toolCallId":"tool-1","inputTextDelta":"{}"}\n\n');
            write('data: {"type":"tool-input-available","toolCallId":"tool-1","toolName":"preview_change","input":{}}\n\n');
            write('data: {"type":"tool-output-available","toolCallId":"tool-1","output":{"summary":"preview ready"}}\n\n');
            await new Promise((resolve) => setTimeout(resolve, 100));
            textSent = true;
            write('data: {"type":"text-start","id":"text-1"}\n\n');
            write('data: {"type":"text-delta","id":"text-1","delta":"First chunk"}\n\n');
            const latch = Promise.withResolvers<void>();
            (window as Window & { __releaseRaceEngineerStream?: () => void }).__releaseRaceEngineerStream = () => {
              releaseCalled = true;
              latch.resolve();
            };
            await latch.promise;
            streamResumed = true;
            setTimeout(() => {
              finalChunkSent = true;
              write('data: {"type":"text-delta","id":"text-1","delta":" second chunk"}\n\n');
              write('data: {"type":"text-end","id":"text-1"}\n\n');
              write('data: {"type":"finish","finishReason":"stop"}\n\n');
              write("data: [DONE]\n\n");
              controller.close();
            }, 50);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
          },
        });
      };
    });

    await page.goto("/");
    await completeOnboarding(page);
    const settingsResponse = await page.request.put("/api/settings", {
      data: {
        aiProvider: "local",
        aiModel: "playwright-stream",
        chatProvider: "local",
        chatModel: "playwright-stream",
        localEndpoint: "http://127.0.0.1:9/v1",
      },
    });
    expect(settingsResponse.ok()).toBeTruthy();

    const createResponse = await page.request.post("/api/experiments", {
      data: {
        gameId: "acc",
        name: "E2E Race Engineer stream",
        carName: "e2e-car",
        trackName: "e2e-track",
        baseSetupPath: "fixtures/e2e-base.json",
        focus: "car",
      },
    });
    expect(createResponse.status()).toBe(201);
    const session = (await createResponse.json()) as { id: number };
    await page.goto(`/acc/experiments/${session.id}`);
    await page.reload();

    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("Stream this reply");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as Window & { __raceTextSent?: boolean }).__raceTextSent)).toBe(true);
    await expect(page.getByText("First chunk", { exact: false })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({ timeout: 15000 });

    expect(await page.evaluate(() => {
      (window as Window & { __releaseRaceEngineerStream?: () => void }).__releaseRaceEngineerStream?.();
      return (window as Window & { __raceReleased?: boolean }).__raceReleased;
    })).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as Window & { __raceStreamResumed?: boolean }).__raceStreamResumed)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as Window & { __raceFinalChunkSent?: boolean }).__raceFinalChunkSent)).toBe(true);
    await expect(page.getByText("First chunk second chunk", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 15000 });
    expect(consoleErrors.filter((message) => message.includes("Maximum update depth exceeded"))).toEqual([]);
  });
  test("keeps typed chat input visible", async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);

    const settingsResponse = await page.request.put("/api/settings", {
      data: {
        aiProvider: "local",
        aiModel: "playwright-input",
        chatProvider: "local",
        chatModel: "playwright-input",
        localEndpoint: "http://127.0.0.1:9/v1",
      },
    });
    expect(settingsResponse.ok()).toBeTruthy();

    const createResponse = await page.request.post("/api/experiments", {
      data: {
        gameId: "acc",
        name: "E2E chat input",
        carName: "e2e-car",
        trackName: "e2e-track",
        baseSetupPath: "fixtures/e2e-base.json",
        focus: "car",
      },
    });
    expect(createResponse.status()).toBe(201);
    const session = (await createResponse.json()) as { id: number };
    await page.goto(`/acc/experiments/${session.id}`);

    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("Visible input");
    await expect(input).toHaveValue("Visible input");
  });
});
