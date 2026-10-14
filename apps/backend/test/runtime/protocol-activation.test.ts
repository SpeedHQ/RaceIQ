import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, test } from "bun:test";
import { forwardRaceIqActivation, parseRaceIqImportLink, startRaceIqActivationBroker } from "../../src/runtime/protocol-activation";

const trustedUrl = "https://raceiq.snazzie.space/api/v1/laps/lap_123/import.zip";
const activation = `raceiq://import?url=${encodeURIComponent(trustedUrl)}`;

describe("RaceIQ protocol activation", () => {
  test("validates import deep links and rejects unsafe forms", () => {
    expect(parseRaceIqImportLink(activation)).toBe(activation);
    expect(parseRaceIqImportLink("https://example.com/")).toBeNull();
    expect(parseRaceIqImportLink(`raceiq://other?url=${encodeURIComponent(trustedUrl)}`)).toBeNull();
    expect(parseRaceIqImportLink(`raceiq://import/path?url=${encodeURIComponent(trustedUrl)}`)).toBeNull();
    expect(parseRaceIqImportLink(`raceiq://import?url=${encodeURIComponent("http://raceiq.snazzie.space/api/v1/laps/lap_123/import.zip")}`)).toBeNull();
    expect(parseRaceIqImportLink(`raceiq://import?url=${encodeURIComponent("https://user:secret@raceiq.snazzie.space/api/v1/laps/lap_123/import.zip")}`)).toBeNull();
    expect(parseRaceIqImportLink(`${activation}&url=${encodeURIComponent(trustedUrl)}`)).toBeNull();
    expect(parseRaceIqImportLink(`raceiq://import?url=${encodeURIComponent("https://raceiq.snazzie.space/api/v1/laps/lap%2F123/import.zip")}`)).toBeNull();
    expect(parseRaceIqImportLink(`raceiq://import?url=${encodeURIComponent("https://raceiq.snazzie.space/api/v1/laps/lap%20123/import.zip")}`)).toBeNull();
    expect(parseRaceIqImportLink(`raceiq://import?url=${encodeURIComponent(`https://raceiq.snazzie.space/api/v1/laps/${"a".repeat(129)}/import.zip`)}`)).toBeNull();

    expect(parseRaceIqImportLink(`${activation}#fragment`)).toBeNull();
  });

  test("acks queued activations despite delayed dispatch and processes one message per connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raceiq-protocol-"));
    const pipePath = join(directory, "activation.sock");
    const { promise: dispatchStarted, resolve: markDispatchStarted } = Promise.withResolvers<void>();
    const { promise: dispatchTwice, resolve: markDispatchTwice } = Promise.withResolvers<void>();
    const { promise: finishDispatch, resolve: finish } = Promise.withResolvers<void>();
    let dispatchCount = 0;
    const broker = await startRaceIqActivationBroker(async () => {
      dispatchCount++;
      markDispatchStarted();
      if (dispatchCount === 2) markDispatchTwice();
      await finishDispatch;
    }, { pipePath });
    expect(broker).not.toBeNull();
    try {
      const bad = createConnection(pipePath);
      const malformedResponse = new Promise<string>((resolve, reject) => {
        let response = "";
        bad.on("data", (chunk) => { response += chunk.toString(); });
        bad.on("end", () => resolve(response));
        bad.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        bad.once("connect", resolve);
        bad.once("error", reject);
      });
      bad.end("not-json\n");
      const disconnected = createConnection(pipePath);
      await new Promise<void>((resolve, reject) => {
        disconnected.once("connect", resolve);
        disconnected.once("error", reject);
      });
      const disconnectedClose = new Promise<void>((resolve) => disconnected.once("close", resolve));
      disconnected.destroy();
      await disconnectedClose;

      expect(await malformedResponse).toBe("rejected\n");

      expect(await forwardRaceIqActivation(activation, { pipePath })).toBe(true);
      await dispatchStarted;
      expect(dispatchCount).toBe(1);

      const repeated = createConnection(pipePath);
      const repeatedResponse = new Promise<string>((resolve, reject) => {
        let response = "";
        repeated.on("data", (chunk) => { response += chunk.toString(); });
        repeated.on("end", () => resolve(response));
        repeated.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        repeated.once("connect", resolve);
        repeated.once("error", reject);
      });
      const message = `${JSON.stringify({ url: activation })}\n`;
      repeated.end(message + message);
      expect(await repeatedResponse).toBe("ok\n");
      await dispatchTwice;
      expect(dispatchCount).toBe(2);
    } finally {
      finish();
      if (broker) await broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
