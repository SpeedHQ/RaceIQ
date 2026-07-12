import { useState } from "react";
import { useGameId } from "../stores/game";
import { useSettings } from "../hooks/queries";

function ForzaSetupGuide({ port }: { port: string }) {
  return (
    <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
      <h3 className="text-sm font-semibold text-app-text mb-3">Forza Motorsport (2023) — Data Out Setup</h3>
      <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
        <li>
          Open <span className="text-app-text">Forza Motorsport</span> and go to <span className="text-app-text">Settings</span>.
        </li>
        <li>
          Navigate to <span className="text-app-text">Gameplay &amp; HUD</span>.
        </li>
        <li>
          Scroll down to the <span className="text-app-text">UDP Race Telemetry</span> section.
        </li>
        <li>
          Set <span className="text-app-text">Data Out</span> to <span className="text-app-accent font-medium">On</span>.
        </li>
        <li>
          Set <span className="text-app-text">Data Out IP Address</span> to your PC's local IP address (e.g.{" "}
          <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">192.168.1.x</code>
          ).
          <p className="mt-1 text-xs text-app-text-muted/70">
            If the game is on the same PC, use <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
          </p>
        </li>
        <li>
          Set <span className="text-app-text">Data Out IP Port</span> to <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{port}</code> (must match Settings &gt;
          Connection).
        </li>
        <li>
          Set <span className="text-app-text">Data Out Packet Format</span> to <span className="text-app-accent font-medium">Car Dash</span>.
        </li>
      </ol>
      <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <p className="text-xs text-amber-400">
          <span className="font-semibold">Note:</span> Telemetry only sends data while you're in an active session (Practice, Qualifying, or Race). You won't receive data from menus or replays.
        </p>
      </div>
    </div>
  );
}

function F1SetupGuide({ port }: { port: string }) {
  return (
    <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
      <h3 className="text-sm font-semibold text-app-text mb-3">EA Sports F1 2025 — UDP Telemetry Setup</h3>
      <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
        <li>
          Open <span className="text-app-text">F1 2025</span> and go to <span className="text-app-text">Settings</span> (main menu).
        </li>
        <li>
          Navigate to <span className="text-app-text">Telemetry Settings</span>.
        </li>
        <li>
          Set <span className="text-app-text">UDP Telemetry</span> to <span className="text-app-accent font-medium">On</span>.
        </li>
        <li>
          Set <span className="text-app-text">UDP Broadcast Mode</span> to <span className="text-app-accent font-medium">Off</span> (unicast).
        </li>
        <li>
          Set <span className="text-app-text">UDP IP Address</span> to your PC's local IP address.
          <p className="mt-1 text-xs text-app-text-muted/70">
            If the game is on the same PC, use <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
          </p>
        </li>
        <li>
          Set <span className="text-app-text">UDP Port</span> to <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{port}</code> (must match Settings &gt;
          Connection).
        </li>
        <li>
          Set <span className="text-app-text">UDP Send Rate</span> to <span className="text-app-accent font-medium">60 Hz</span> for best data quality.
        </li>
        <li>
          Set <span className="text-app-text">UDP Format</span> to <span className="text-app-accent font-medium">2025</span>.
        </li>
      </ol>
      <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <p className="text-xs text-amber-400">
          <span className="font-semibold">Note:</span> Telemetry only sends during active sessions (Practice, Qualifying, Sprint, Race).
        </p>
      </div>
    </div>
  );
}

function AccSetupGuide() {
  return (
    <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
      <h3 className="text-sm font-semibold text-app-text mb-3">Assetto Corsa Competizione — Setup</h3>
      <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
        <li>
          ACC uses <span className="text-app-text">shared memory</span> — no UDP configuration required.
        </li>
        <li>
          RaceIQ must be running on the <span className="text-app-text">same PC</span> as Assetto Corsa Competizione.
        </li>
        <li>
          Launch ACC and enter a <span className="text-app-text">practice or race session</span> — data will appear automatically once the session starts.
        </li>
      </ol>
      <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <p className="text-xs text-amber-400">
          <span className="font-semibold">Note:</span> Shared memory is only active while ACC is running and a session is in progress. Data won't appear from the main menu.
        </p>
      </div>
    </div>
  );
}

export function NoDataView() {
  const [expanded, setExpanded] = useState(false);
  const gameId = useGameId();
  const { displaySettings } = useSettings();
  const port = String((displaySettings as any).udpPort ?? "5300");

  const guideLabel = gameId === "f1-2025" ? "How to enable UDP Telemetry in F1 2025" : gameId === "acc" ? "How to connect Assetto Corsa Competizione" : "How to enable Data Out in Forza Motorsport";

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
      <div className="animate-pulse text-app-text-dim">
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"
          />
        </svg>
      </div>

      <div className="text-center">
        <div className="text-sm font-semibold text-app-text">Waiting for telemetry</div>
        <div className="text-xs text-app-text-muted mt-1">Start a session in-game to begin receiving data</div>
      </div>

      <div>
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-sm text-app-accent hover:text-app-accent/80 transition-colors">
          <svg className={`w-4 h-4 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {guideLabel}
        </button>

        {expanded && (gameId === "f1-2025" ? <F1SetupGuide port={port} /> : gameId === "acc" ? <AccSetupGuide /> : <ForzaSetupGuide port={port} />)}
      </div>
    </div>
  );
}
