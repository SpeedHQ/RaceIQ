import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export function ConnectionSection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [udpPort, setUdpPort] = useState("5301");
  const [showF1SetupGuide, setShowF1SetupGuide] = useState(false);
  const [savedPort, setSavedPort] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (displaySettings.udpPort != null && savedPort === null) {
      setUdpPort(String(displaySettings.udpPort));
      setSavedPort(displaySettings.udpPort);
    }
  }, [displaySettings.udpPort, savedPort]);

  const port = Number.parseInt(udpPort, 10);
  const hasChanges = savedPort === null || port !== savedPort;

  async function handleSave() {
    const savePort = Number.parseInt(udpPort, 10);
    if (Number.isNaN(savePort) || savePort < 1024 || savePort > 65535) {
      setStatus("error");
      setErrorMsg(m.settings_port_range_error());
      return;
    }
    setStatus("saving");
    setErrorMsg("");
    try {
      await saveSettings.mutateAsync({ udpPort: savePort });
      setSavedPort(savePort);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : m.label_failed_to_save());
    }
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-1">{m.settings_connection_title()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.settings_connection_desc()}</p>
      <div className="flex items-end gap-3 max-w-xs">
        <div className="flex-1">
          <Label htmlFor="udp-port" className="text-app-text-secondary">
            {m.label_udp_port()}
          </Label>
          <Input
            id="udp-port"
            type="number"
            min={1024}
            max={65535}
            value={udpPort}
            onChange={(e) => {
              setUdpPort(e.target.value);
              setStatus("idle");
            }}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            className="border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1.5"
            placeholder="5301"
          />
        </div>
        <Button onClick={handleSave} disabled={status === "saving" || !hasChanges} variant={status === "saved" ? "secondary" : "default"} className="shrink-0">
          {status === "saving" ? m.common_saving() : status === "saved" ? m.common_saved() : m.common_save()}
        </Button>
      </div>
      {status === "error" && <p className="text-status-danger text-sm mt-2">{errorMsg}</p>}
      {savedPort && (
        <p className="text-app-text-muted text-xs mt-3">
          {m.settings_listening_on()} 0.0.0.0:{savedPort}
        </p>
      )}
      <div className="mt-4 max-w-xs">
        <Label htmlFor="ws-refresh-rate" className="text-app-text-secondary">
          {m.settings_live_refresh_rate()}
        </Label>
        <select
          id="ws-refresh-rate"
          value={displaySettings.wsRefreshRate ?? "60"}
          onChange={(e) => saveSettings.mutate({ wsRefreshRate: e.target.value })}
          className="mt-1.5 w-full bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text"
        >
          <option value="60">60 Hz</option>
          <option value="50">50 Hz</option>
          <option value="40">40 Hz</option>
          <option value="30">30 Hz</option>
        </select>
        <p className="text-app-text-muted text-xs mt-1">{m.settings_live_refresh_rate_desc()}</p>
      </div>
      <div className="mt-4 max-w-xs">
        <Label htmlFor="render-fps-cap" className="text-app-text-secondary">
          {m.settings_render_frame_cap()}
        </Label>
        <select
          id="render-fps-cap"
          value={String(displaySettings.renderFpsCap ?? 60)}
          onChange={(e) => saveSettings.mutate({ renderFpsCap: Number(e.target.value) })}
          className="mt-1.5 w-full bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text"
        >
          <option value="120">120 fps</option>
          <option value="90">90 fps</option>
          <option value="60">60 fps</option>
          <option value="45">45 fps</option>
          <option value="30">30 fps</option>
          <option value="15">15 fps</option>
        </select>
        <p className="text-app-text-muted text-xs mt-1">{m.settings_render_frame_cap_desc()}</p>
      </div>
      <div className="mt-6 pt-6 border-t border-app-border">
        <Button variant="app-ghost" size="app-sm" onClick={() => setShowSetupGuide(!showSetupGuide)}>
          <svg aria-hidden="true" className={`w-4 h-4 transition-transform ${showSetupGuide ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {m.settings_forza_guide_toggle()}
        </Button>
        {showSetupGuide && (
          <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
            <h3 className="text-sm font-semibold text-app-text mb-3">{m.settings_forza_guide_title()}</h3>
            <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
              <li>{m.setupguide_forza_step1()}</li>
              <li>{m.setupguide_forza_step2()}</li>
              <li>{m.setupguide_forza_step3()}</li>
              <li>{m.setupguide_data_out_on()}</li>
              <li>
                {m.setupguide_data_out_ip()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">192.168.1.x</code> ).
                <p className="mt-1 text-xs text-app-text-muted/70">
                  {m.settingsguide_same_pc_running()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
                </p>
              </li>
              <li>
                {m.setupguide_data_out_port()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{udpPort || "5301"}</code> {m.settingsguide_match_port_above()}
              </li>
              <li>{m.setupguide_data_out_packet_format()}</li>
            </ol>
            <div className="mt-4 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2">
              <p className="text-xs text-status-warning">
                <span className="font-semibold">{m.setupguide_note_label()}</span> {m.settingsguide_forza_note()}
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="mt-3">
        <Button variant="app-ghost" size="app-sm" onClick={() => setShowF1SetupGuide(!showF1SetupGuide)}>
          <svg aria-hidden="true" className={`w-4 h-4 transition-transform ${showF1SetupGuide ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {m.settings_f1_guide_toggle()}
        </Button>
        {showF1SetupGuide && (
          <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
            <h3 className="text-sm font-semibold text-app-text mb-3">{m.settings_f1_guide_title()}</h3>
            <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
              <li>{m.setupguide_f1_step1()}</li>
              <li>{m.setupguide_f1_step2()}</li>
              <li>{m.setupguide_udp_telemetry_on()}</li>
              <li>{m.setupguide_udp_broadcast_off()}</li>
              <li>
                {m.setupguide_udp_ip()}
                <p className="mt-1 text-xs text-app-text-muted/70">
                  {m.settingsguide_same_pc_running()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
                </p>
              </li>
              <li>
                {m.setupguide_udp_port()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{udpPort || "5300"}</code> {m.settingsguide_match_port_above()}
              </li>
              <li>{m.setupguide_udp_send_rate()}</li>
              <li>{m.setupguide_udp_format()}</li>
            </ol>
            <div className="mt-4 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2">
              <p className="text-xs text-status-warning">
                <span className="font-semibold">{m.setupguide_note_label()}</span> {m.settingsguide_f1_note()}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
