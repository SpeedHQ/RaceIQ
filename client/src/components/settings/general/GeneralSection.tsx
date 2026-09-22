import { LOCALES } from "@shared/platform/i18n/locales";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";

export function GeneralSection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [languageError, setLanguageError] = useState("");

  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-1">{m.label_general()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.settings_general_desc()}</p>
      <div className="max-w-xs mb-6">
        <Label htmlFor="settings-language" className="text-app-text-secondary">
          {m.label_language()}
        </Label>
        <div className="mt-1.5">
          <SearchSelect
            id="settings-language"
            value={displaySettings.language ?? "en"}
            onChange={async (code) => {
              setLanguageError("");
              try {
                await saveSettings.mutateAsync({ language: code });
                applyLocale(code);
              } catch (err) {
                setLanguageError(err instanceof Error ? err.message : m.label_failed_to_save());
              }
            }}
            options={LOCALES.map((loc) => ({ value: loc.code, label: `${loc.label} (${loc.code})` }))}
            placeholder={m.settings_language_search_placeholder()}
            focusColor="app-accent"
          />
        </div>
        <p className="text-app-text-muted text-xs mt-1">{m.settings_language_desc()}</p>
        {languageError && (
          <p className="text-status-danger text-xs mt-1" role="alert">
            {languageError}
          </p>
        )}
      </div>
      <div className="max-w-xs">
        <Label htmlFor="launch-on-login" className={`${displaySettings.isCompiled ? "text-app-text-secondary" : "text-app-text-muted"}`}>
          {m.label_launch_on_login()}
        </Label>
        <div className="flex items-center gap-3 mt-1.5">
          <Switch
            id="launch-on-login"
            aria-label={m.label_launch_on_login()}
            disabled={!displaySettings.isCompiled}
            checked={!!displaySettings.launchOnLogin}
            onCheckedChange={(checked) => displaySettings.isCompiled && saveSettings.mutate({ launchOnLogin: checked })}
          />
          <span className="text-sm text-app-text-muted">
            {!displaySettings.isCompiled ? m.settings_launch_installed_only() : displaySettings.launchOnLogin ? m.common_enabled() : m.common_disabled()}
          </span>
        </div>
        <p className="text-app-text-muted text-xs mt-1">{m.settings_launch_on_login_desc()}</p>
      </div>
    </section>
  );
}
