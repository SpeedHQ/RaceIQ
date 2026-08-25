import { expect, test } from "bun:test";
import { AccBroadcastClient } from "../../../server/games/acc/broadcast-client";
import { AccBroadcastState } from "../../../server/games/acc/broadcast-state";

test("registers ACC broadcast client and applies inbound messages", async () => {
  const sent: Uint8Array[] = [];
  let onMessage: ((message: Buffer) => void) | undefined;
  let closed = false;
  const socket = {
    connect: (_port: number, _host: string, callback?: () => void) => callback?.(),
    send: (message: Uint8Array) => sent.push(message),
    on: (event: string, listener: (message: Buffer) => void) => { if (event === "message") onMessage = listener; },
    close: (callback?: () => void) => { closed = true; callback?.(); },
  };
  const state = new AccBroadcastState();
  const client = new AccBroadcastClient({ state, socketFactory: () => socket });
  await client.start();
  expect(sent[0]?.[0]).toBe(1);
  onMessage?.(Buffer.from([255]));
  await client.stop();
  expect(closed).toBe(true);
});
