import { useState } from "react";
import { m } from "@/paraglide/messages";
import { useSettings } from "../hooks/settings";
import { useGameId } from "../stores/game";
import { Button } from "./ui/button";

function ForzaSetupGuide({ port }: { port: string }) {
  return (
    <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
      <h3 className="text-sm font-semibold text-app-text mb-3">{m.setupguide_forza_title()}</h3>
      <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
        <li>{m.setupguide_forza_step1()}</li>
        <li>{m.setupguide_forza_step2()}</li>
        <li>{m.setupguide_forza_step3()}</li>
        <li>{m.setupguide_data_out_on()}</li>
        <li>
          {m.setupguide_data_out_ip()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">192.168.1.x</code>
          ).
          <p className="mt-1 text-xs text-app-text-muted/70">
            {m.setupguide_same_pc_note()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
          </p>
        </li>
        <li>
          {m.setupguide_data_out_port()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{port}</code> {m.setupguide_match_settings()}
        </li>
        <li>{m.setupguide_data_out_packet_format()}</li>
      </ol>
      <div className="mt-4 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2">
        <p className="text-xs text-status-warning">
          <span className="font-semibold">{m.setupguide_note_label()}</span> {m.setupguide_forza_note()}
        </p>
      </div>
    </div>
  );
}

function F1SetupGuide({ port }: { port: string }) {
  return (
    <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
      <h3 className="text-sm font-semibold text-app-text mb-3">{m.setupguide_f1_title()}</h3>
      <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
        <li>{m.setupguide_f1_step1()}</li>
        <li>{m.setupguide_f1_step2()}</li>
        <li>{m.setupguide_udp_telemetry_on()}</li>
        <li>{m.setupguide_udp_broadcast_off()}</li>
        <li>
          {m.setupguide_udp_ip()}
          <p className="mt-1 text-xs text-app-text-muted/70">
            {m.setupguide_same_pc_note()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
          </p>
        </li>
        <li>
          {m.setupguide_udp_port()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{port}</code> {m.setupguide_match_settings()}
        </li>
        <li>{m.setupguide_udp_send_rate()}</li>
        <li>{m.setupguide_udp_format()}</li>
      </ol>
      <div className="mt-4 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2">
        <p className="text-xs text-status-warning">
          <span className="font-semibold">{m.setupguide_note_label()}</span> {m.setupguide_f1_note()}
        </p>
      </div>
    </div>
  );
}

function AccSetupGuide() {
  return (
    <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
      <h3 className="text-sm font-semibold text-app-text mb-3">{m.setupguide_acc_title()}</h3>
      <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
        <li>
          {m.setupguide_acc_step1_prefix()} <span className="text-app-text">{m.setupguide_acc_shared_memory()}</span> {m.setupguide_acc_step1_suffix()}
        </li>
        <li>
          {m.setupguide_acc_step2_prefix()} <span className="text-app-text">{m.setupguide_acc_same_pc()}</span> {m.setupguide_acc_step2_suffix()}
        </li>
        <li>
          {m.setupguide_acc_step3_prefix()} <span className="text-app-text">{m.setupguide_acc_practice_session()}</span> {m.setupguide_acc_step3_suffix()}
        </li>
      </ol>
      <div className="mt-4 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2">
        <p className="text-xs text-status-warning">
          <span className="font-semibold">{m.setupguide_note_label()}</span> {m.setupguide_acc_note()}
        </p>
      </div>
    </div>
  );
}

function IRacingSetupGuide() {
  return (
    <div className="mt-3 w-[420px] max-w-[calc(100vw-2rem)] rounded-lg border border-app-border bg-app-surface p-4 text-sm text-app-text-muted">
      <ol className="list-decimal space-y-2 pl-5">
        <li>Start the iRacing simulator on this Windows PC.</li>
        <li>Enter the car and begin driving in a test, practice, qualifying, or race session.</li>
        <li>RaceIQ connects directly to iRacing's native shared-memory SDK; no UDP setup or separate SDK wrapper is required.</li>
      </ol>
    </div>
  );
}

function LMUSetupGuide() {
  return (
    <div className="mt-3 w-[420px] max-w-[calc(100vw-2rem)] rounded-lg border border-app-border bg-app-surface p-4 text-sm text-app-text-muted">
      <ol className="list-decimal space-y-2 pl-5">
        <li>Start Le Mans Ultimate on this Windows PC.</li>
        <li>Turn on Gameplay &gt; Enable Plugins, then enter a driving session.</li>
        <li>RaceIQ connects to LMU&apos;s built-in shared-memory telemetry automatically.</li>
      </ol>
      <p className="mt-3 text-xs">
        Saved LMU telemetry databases can also be uploaded from Sessions.
      </p>
    </div>
  );
}

export function NoDataView() {
  const [expanded, setExpanded] = useState(false);
  const gameId = useGameId();
  const { displaySettings } = useSettings();
  const port = String((displaySettings as any).udpPort ?? "5300");

  const guideLabel = gameId === "iracing" ? "How to connect iRacing" : gameId === "lmu" ? "How to connect Le Mans Ultimate" : gameId === "f1-2025" ? m.settings_f1_guide_toggle() : gameId === "acc" ? m.nodata_guide_acc() : m.settings_forza_guide_toggle();

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
        <div className="text-sm font-semibold text-app-text">{m.nodata_waiting_title()}</div>
        <div className="text-xs text-app-text-muted mt-1">{m.nodata_waiting_desc()}</div>
      </div>

      <div>
        <Button variant="app-ghost" size="app-md" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="!p-0 text-sm text-app-accent hover:text-app-accent/80">
          <svg className={`w-4 h-4 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {guideLabel}
        </Button>

        {expanded && (gameId === "iracing" ? <IRacingSetupGuide /> : gameId === "lmu" ? <LMUSetupGuide /> : gameId === "f1-2025" ? <F1SetupGuide port={port} /> : gameId === "acc" ? <AccSetupGuide /> : <ForzaSetupGuide port={port} />)}
      </div>
    </div>
  );
}
