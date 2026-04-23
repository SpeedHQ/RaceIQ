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
}

export function deriveConnectionStatusView(
  inputs: ConnectionStatusInputs
): ConnectionStatusView {
  const { connected, forzaReceiving, detectedGame } = inputs;

  const gameLabel = detectedGame?.name ?? null;

  let gameText: string;
  if (forzaReceiving) {
    gameText = gameLabel ?? "Receiving";
  } else if (gameLabel) {
    gameText = `${gameLabel} — Waiting`;
  } else {
    gameText = "No Signal";
  }

  let dotColor: ConnectionStatusView["dotColor"];
  if (forzaReceiving) dotColor = "cyan";
  else if (gameLabel) dotColor = "amber";
  else dotColor = "dim";

  return {
    serverLabel: connected ? "Server" : "Disconnected",
    gameLabel,
    gameText,
    dotColor,
  };
}
