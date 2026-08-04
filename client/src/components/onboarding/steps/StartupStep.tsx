import { Button } from "@/components/ui/button";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export function StartupStep() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const enabled = !!displaySettings.isCompiled;
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_launch_on_login()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_startup_desc()}</p>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          role="switch"
          disabled={!enabled}
          aria-checked={!!displaySettings.launchOnLogin}
          onClick={() => enabled && saveSettings.mutate({ launchOnLogin: !displaySettings.launchOnLogin })}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent ${!enabled ? "opacity-40 cursor-not-allowed bg-app-surface-alt border border-app-border-input" : displaySettings.launchOnLogin ? "cursor-pointer bg-app-accent" : "cursor-pointer bg-app-surface-alt border border-app-border-input"}`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-app-text shadow-lg ring-0 transition-transform ${displaySettings.launchOnLogin ? "translate-x-4" : "translate-x-0"}`}
          />
        </Button>
        <span className="text-sm text-app-text-muted">{!enabled ? m.settings_launch_installed_only() : displaySettings.launchOnLogin ? m.common_enabled() : m.common_disabled()}</span>
      </div>
    </div>
  );
}
