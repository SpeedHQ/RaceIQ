import { getAllGames } from "@raceiq/games/registry";
import { clientReleaseFeatures } from "../lib/release-features";
import { useSettings } from "../hooks/settings";
import { m } from "@/paraglide/messages";

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
        <li>{m.nodata_iracing_step_start()}</li>
        <li>{m.nodata_iracing_step_enter()}</li>
        <li>{m.nodata_iracing_step_sdk()}</li>
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
  const { displaySettings } = useSettings();
  const settings = displaySettings as { udpPort?: number };
  const port = String(settings.udpPort ?? "5300");
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-4 p-4 sm:p-8">
      <div className="animate-pulse text-app-text-dim" aria-hidden="true">◉</div>
      <div className="text-center">
        <div className="text-sm font-semibold text-app-text">{m.nodata_waiting_title()}</div>
        <div className="text-xs text-app-text-muted mt-1">{m.nodata_waiting_desc()}</div>
      </div>
      <div className="w-full max-w-lg space-y-2">
        {getAllGames().filter((game) => game.id !== "iracing" || clientReleaseFeatures.iracingAdapter).map((game) => (
          <details key={game.id} name="telemetry-guide" className="rounded-lg border border-app-border bg-app-surface-alt px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-app-accent">{game.displayName}</summary>
            <div className="max-h-[50vh] overflow-y-auto">
              {game.id === "fm-2023" && <ForzaSetupGuide port={port} />}
              {game.id === "f1-2025" && <F1SetupGuide port={port} />}
              {game.id === "acc" && <AccSetupGuide />}
              {game.id === "iracing" && <IRacingSetupGuide />}
              {game.id === "lmu" && <LMUSetupGuide />}
              {game.id === "ac-evo" && <div className="mt-3 rounded-lg border border-app-border bg-app-surface p-4 text-sm text-app-text-muted"><ol className="list-decimal space-y-2 pl-5"><li>Run Assetto Corsa EVO on this Windows PC.</li><li>Enter an active driving session; telemetry is provided through the game’s local shared-memory interface.</li><li>Keep RaceIQ running on the same PC while driving.</li></ol></div>}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
