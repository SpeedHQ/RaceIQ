import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CodexRpcConnection } from "../../../src/ai/codex/rpc";

function connectPeer(mode = "echo", options: { maxFrameBytes?: number; onNotification?: (method: string, params: unknown) => void } = {}) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/codex-peer.ts", import.meta.url)), mode], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  return new CodexRpcConnection(
    {
      stdout: child.stdout,
      async write(line) {
        child.stdin.write(line);
        await child.stdin.flush();
      },
      async close() {
        child.stdin.end();
        child.kill();
        await child.exited;
      },
    },
    options,
  );
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Test safety deadline")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("round-trips JSON over real subprocess stdio", async () => {
  const connection = connectPeer();
  try {
    expect(await connection.request("probe", { label: "ação" })).toEqual({ label: "ação" });
  } finally {
    await connection.close();
  }
});

test("decodes UTF-8 code points split across one-byte transport chunks", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const connection = new CodexRpcConnection({
    stdout: new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
    write(line) {
      const request = JSON.parse(line);
      const bytes = new TextEncoder().encode(JSON.stringify({ id: request.id, result: request.params }) + "\n");
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    },
    close() {
      controller.close();
    },
  });
  try {
    expect(await connection.request("probe", { label: "ação 🏎️" })).toEqual({ label: "ação 🏎️" });
  } finally {
    await connection.close();
  }
});

test("correlates concurrent requests when the peer replies out of order", async () => {
  const connection = connectPeer("reverse");
  try {
    const first = connection.request("probe", { lap: 1 });
    const second = connection.request("probe", { lap: 2 });
    expect(await Promise.all([first, second])).toEqual([{ lap: 1 }, { lap: 2 }]);
  } finally {
    await connection.close();
  }
});

test("denies unsolicited execution approval requests rather than granting capabilities", async () => {
  const connection = connectPeer("approval");
  try {
    expect(await connection.request("probe", {})).toEqual({ denied: true });
  } finally {
    await connection.close();
  }
});

test("reports RPC failures without retaining upstream messages or credential-shaped payloads", async () => {
  const connection = connectPeer("error");
  try {
    const error = await connection.request("probe", {}).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: "remote", code: -32000, message: "Codex RPC request failed" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
  } finally {
    await connection.close();
  }
});

test("rejects every pending request when the Codex process exits", async () => {
  const connection = connectPeer("exit");
  try {
    const results = await within(Promise.allSettled([connection.request("first", {}), connection.request("second", {})]));
    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ kind: "closed" }) },
      { status: "rejected", reason: expect.objectContaining({ kind: "closed" }) },
    ]);
    await expect(connection.request("after-exit", {})).rejects.toMatchObject({ kind: "closed" });
  } finally {
    await connection.close();
  }
});

test("a stalled RPC reaches its deadline and closes rather than silently retrying", async () => {
  const connection = connectPeer("hang");
  try {
    await expect(within(connection.request("probe", {}, { timeoutMs: 30 }))).rejects.toMatchObject({ kind: "timeout" });
    await expect(connection.request("after-timeout", {})).rejects.toMatchObject({ kind: "timeout" });
  } finally {
    await connection.close();
  }
});

test("cancelling an in-flight RPC closes the owned connection and rejects its waiters", async () => {
  let received!: () => void;
  const receipt = new Promise<void>((resolve) => {
    received = resolve;
  });
  const connection = connectPeer("hang", {
    onNotification(method) {
      if (method === "test/requestReceived") received();
    },
  });
  const controller = new AbortController();
  try {
    const pending = connection.request("probe", {}, { signal: controller.signal }).catch((failure: unknown) => failure);
    await within(receipt);
    controller.abort();
    expect(await within(pending)).toMatchObject({ kind: "cancelled" });
    await expect(connection.request("after-cancel", {})).rejects.toMatchObject({ kind: "cancelled" });
  } finally {
    await connection.close();
  }
});

test("malformed peer output fails closed without leaking its contents", async () => {
  const connection = connectPeer("malformed");
  try {
    const error = await within(connection.request("probe", {})).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: "protocol", message: "Invalid Codex RPC stream" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
  } finally {
    await connection.close();
  }
});

test("rejects an oversized unterminated frame before the peer closes", async () => {
  const connection = connectPeer("oversized", { maxFrameBytes: 128 });
  try {
    await expect(within(connection.request("probe", {}))).rejects.toMatchObject({ kind: "protocol" });
  } finally {
    await connection.close();
  }
});

test("valid JSON with an invalid response envelope is not mistaken for success", async () => {
  const connection = connectPeer("invalid-envelope");
  try {
    await expect(within(connection.request("probe", {}))).rejects.toMatchObject({ kind: "protocol" });
  } finally {
    await connection.close();
  }
});

test("streams notifications without confusing them with the pending RPC response", async () => {
  const notifications: unknown[] = [];
  const connection = connectPeer("notifications", {
    onNotification(method, params) {
      notifications.push({ method, params });
    },
  });
  try {
    expect(await connection.request("probe", { response: true })).toEqual({ response: true });
    expect(notifications).toEqual([{ method: "item/agentMessage/delta", params: { delta: "ação" } }]);
  } finally {
    await connection.close();
  }
});

test("sends initialized as a notification without waiting for a nonexistent response", async () => {
  const connection = connectPeer("handshake");
  try {
    await connection.request("initialize", { clientInfo: { name: "raceiq-test", version: "0" } });
    await connection.notify("initialized");
    expect(await connection.request("probe", {})).toEqual({ initialized: true });
  } finally {
    await connection.close();
  }
});

test.each([
  "null",
  "[]",
  "{}",
  '{"method":3}',
  '{"id":{},"result":1}',
  '{"id":1,"result":1,"error":{"code":-1,"message":"bad"}}',
  '{"id":1,"error":{"code":"PRIVATE_TOKEN","message":"PRIVATE_MESSAGE"}}',
])("rejects invalid wire envelopes without exposing payload: %s", async (frame) => {
  const connection = connectPeer("raw");
  try {
    const error = await within(connection.request("probe", { frame })).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: "protocol" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
  } finally {
    await connection.close();
  }
});

test("shutdown failures are reported without retaining transport secrets", async () => {
  let end!: () => void;
  const connection = new CodexRpcConnection({
    stdout: new ReadableStream({
      start(controller) {
        end = () => controller.close();
      },
    }),
    write() {},
    close() {
      end();
      throw new Error("PRIVATE_SHUTDOWN_DETAILS");
    },
  });
  const error = await connection.close().catch((failure: unknown) => failure);
  expect(error).toMatchObject({ kind: "closed", message: "Codex transport shutdown failed" });
  expect(JSON.stringify(error)).not.toContain("PRIVATE_");
});

test("does not deliver queued notifications after the caller closes the connection", async () => {
  const notifications: unknown[] = [];
  const connection = connectPeer("notification-burst", {
    onNotification(_method, params) {
      notifications.push(params);
      void connection.close();
    },
  });
  try {
    await expect(connection.request("probe", {})).rejects.toMatchObject({ kind: "closed" });
    expect(notifications).toEqual([{ delta: "ação" }]);
  } finally {
    await connection.close();
  }
});

test("bounds pending requests without dispatching overflow work", async () => {
  const connection = connectPeer("hang");
  const waiting = Promise.allSettled(Array.from({ length: 64 }, () => connection.request("probe", {})));
  try {
    await expect(within(connection.request("overflow", {}))).rejects.toMatchObject({ kind: "overloaded" });
  } finally {
    await connection.close();
    expect((await waiting).every((entry) => entry.status === "rejected")).toBe(true);
  }
});

test("reports terminal EOF even when no RPC acknowledgement is pending", async () => {
  const connection = new CodexRpcConnection({
    stdout: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    write() {},
    close() {},
  });
  expect(await connection.closed).toMatchObject({ kind: "closed" });
  await connection.close();
});
