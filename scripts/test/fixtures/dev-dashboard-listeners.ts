import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { startDashboardListeners } from "../../dev/dashboard-listeners";

const upstream = createServer((_request, response) => { response.end("dashboard"); });
const upgraded = new Set<Socket>();
upstream.on("upgrade", (_request, socket) => {
  upgraded.add(socket as Socket);
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  socket.on("close", () => upgraded.delete(socket as Socket));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address();
assert(address && typeof address !== "string");
let stop: (() => Promise<void>) | undefined;
try {
  stop = await startDashboardListeners(address.port, ["127.0.0.1", "127.0.0.2"]);
  assert.equal(await (await fetch(`http://127.0.0.2:${address.port}/`)).text(), "dashboard");
  await assert.rejects(fetch(`http://127.0.0.3:${address.port}/`, { signal: AbortSignal.timeout(1000) }));
  const status = await new Promise<string>((resolve, reject) => {
    const socket = connect(address.port, "127.0.0.2", () => {
      socket.write("GET /ws HTTP/1.1\r\nHost: 127.0.0.2\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    socket.on("error", reject);
    socket.once("data", (data) => { resolve(data.toString().split("\r\n")[0]); socket.destroy(); });
  });
  assert.equal(status, "HTTP/1.1 101 Switching Protocols");
  await stop(); stop = undefined;
  await assert.rejects(fetch(`http://127.0.0.2:${address.port}/`, { signal: AbortSignal.timeout(1000) }));
  // A collision must release earlier successful binds rather than leave a
  // partially exposed dashboard or retry on a wildcard address.
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(address.port, "127.0.0.3", resolve));
  try {
    await assert.rejects(startDashboardListeners(address.port, ["127.0.0.1", "127.0.0.2", "127.0.0.3"]));
    await assert.rejects(fetch(`http://127.0.0.2:${address.port}/`, { signal: AbortSignal.timeout(1000) }));
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
} finally {
  await stop?.();
  for (const socket of upgraded) socket.destroy();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
}
