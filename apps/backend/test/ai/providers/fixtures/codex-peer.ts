// External protocol peer. Never invokes Codex, credentials, or inference.
export {};
let buffer = "";
const mode = process.argv[2];
let initialized = false;
const reversed: { id: number; params: unknown }[] = [];
let approval: { id: number } | undefined;
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
  buffer += chunk;
  let boundary: number;
  while ((boundary = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 1);
    const request = JSON.parse(line);
    if (request.id === undefined) {
      if (request.method === "initialized") initialized = true;
      continue;
    }
    if (mode === "reverse") {
      reversed.push(request);
      if (reversed.length === 2) {
        for (const entry of reversed.reverse()) process.stdout.write(JSON.stringify({ id: entry.id, result: entry.params }) + "\n");
      }
      continue;
    }
    if (mode === "raw") {
      process.stdout.write(request.params.frame + "\n");
      continue;
    }
    if (mode === "handshake" && request.method === "probe") {
      process.stdout.write(JSON.stringify({ id: request.id, result: { initialized } }) + "\n");
      continue;
    }
    if (mode === "notifications" || mode === "notification-burst") {
      process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "ação" } }) + "\n");
      if (mode === "notification-burst") process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "late" } }) + "\n");
    }
    if (mode === "invalid-envelope") {
      process.stdout.write(JSON.stringify({ id: request.id, unexpected: "PRIVATE_PAYLOAD" }) + "\n");
      continue;
    }
    if (mode === "oversized") {
      process.stdout.write("x".repeat(1024));
      continue;
    }
    if (mode === "malformed") {
      process.stdout.write("PRIVATE_NOT_JSON\n");
      continue;
    }
    if (mode === "hang") {
      process.stdout.write(JSON.stringify({ method: "test/requestReceived", params: {} }) + "\n");
      continue;
    }
    if (mode === "exit") process.exit(0);
    if (mode === "error") {
      process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: "PRIVATE_UPSTREAM_DIAGNOSTIC", data: { token: "PRIVATE_TOKEN" } } }) + "\n");
      continue;
    }
    if (request.id === "approval-1" && approval) {
      process.stdout.write(JSON.stringify({ id: approval.id, result: { denied: request.error?.code === -32601 } }) + "\n");
      approval = undefined;
      continue;
    }
    if (mode === "approval") {
      approval = { id: request.id };
      process.stdout.write(JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} }) + "\n");
      continue;
    }
    const response = Buffer.from(JSON.stringify({ id: request.id, result: request.params }) + "\n");
    const split = response.indexOf(Buffer.from("ç")) + 1;
    process.stdout.write(response.subarray(0, split));
    process.stdout.write(response.subarray(split));
  }
}
