/**
 * Pure logic for the connection/game-detection chip in the nav.
 * Extracted from ConnectionStatus so it can be unit-tested without React.
 */

export interface ConnectionStatusInputs {
  connected: boolean;
  forzaReceiving: boolean;
  detectedGame: { id: string; name: string } | null | undefined;
}

export interface ConnectionStatusView {
  serverLabel: "Server" | "Disconnected";
  gameLabel: string | null;
  gameText: string;
  dotColor: "green" | "red" | "cyan" | "amber" | "dim";
  statusKind: "disconnected" | "server" | "waiting" | "receiving";
}

export function deriveConnectionStatusView(inputs: ConnectionStatusInputs): ConnectionStatusView {
  const { connected, forzaReceiving, detectedGame } = inputs;

  const gameLabel = detectedGame?.name ?? null;

  if (!connected) {
    return {
      serverLabel: "Disconnected",
      gameLabel: null,
      gameText: "Disconnected",
      dotColor: "red",
      statusKind: "disconnected",
    };
  }

  if (forzaReceiving) {
    return {
      serverLabel: "Server",
      gameLabel,
      gameText: gameLabel ?? "Receiving",
      dotColor: "cyan",
      statusKind: "receiving",
    };
  }

  if (gameLabel) {
    return {
      serverLabel: "Server",
      gameLabel,
      gameText: `${gameLabel} — Waiting`,
      dotColor: "amber",
      statusKind: "waiting",
    };
  }

  return {
    serverLabel: "Server",
    gameLabel: null,
    gameText: "Server",
    dotColor: "green",
    statusKind: "server",
  };
}
