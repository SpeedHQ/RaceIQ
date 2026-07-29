export interface DevWebSocketTarget {
  protocol: "ws:" | "wss:";
  hostname: string;
  port: string;
}

interface WebSocketLocation {
  protocol: string;
  host: string;
  hostname: string;
}

export function buildWebSocketUrl(location: WebSocketLocation, devTarget?: DevWebSocketTarget): string {
  if (devTarget) {
    const hostname = devTarget.hostname || location.hostname;
    const port = devTarget.port ? `:${devTarget.port}` : "";
    return `${devTarget.protocol}//${hostname}${port}/ws`;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}
