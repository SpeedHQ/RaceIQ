import { useState } from "react";
import { LOCALES } from "@raceiq/shared/platform/i18n/locales";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { useTelemetryStore } from "@/stores/telemetry";


export function WelcomeStep({ setup = false }: { setup?: boolean } = {}) {
  const [setupLanguage, setSetupLanguage] = useState<string>(getLocale);
  const versionInfo = useTelemetryStore((s) => s.versionInfo);
  const { displaySettings } = useSettings({ enabled: !setup });
  const saveSettings = useSaveSettings();
  const currentLang = setup ? setupLanguage : displaySettings.language ?? "en";
  const langOptions = LOCALES.map((loc) => ({ value: loc.code, label: `${loc.label} (${loc.code})` }));
  async function selectLanguage(code: string) {
    if (code === currentLang) return;
    if (setup) {
      setSetupLanguage(code);
    } else {
      try {
        await saveSettings.mutateAsync({ language: code });
      } catch {
        /* best-effort persist; still switch UI locale below */
      }
    }
    applyLocale(code);
  }
  return (
    <div className="flex flex-col items-center justify-center text-center py-6">
      <div className="mb-5 relative w-64 h-20">
          <div className="absolute inset-0 bg-app-accent/5 rounded-lg blur-xl" />
          <svg viewBox="0 0 260 80" fill="none" className="relative w-full h-full" aria-hidden="true">
            {[20, 40, 60].map((y) => (
              <line key={y} x1="0" y1={y} x2="260" y2={y} stroke="currentColor" strokeWidth="0.5" className="text-app-border" opacity="0.3" />
            ))}
            <polyline
              points="0,65 20,63 35,25 50,20 70,23 90,60 110,65 125,30 145,15 165,18 180,55 200,63 220,25 240,12 260,15"
              stroke="url(#accentGrad)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              strokeDasharray="400"
              strokeDashoffset="400"
              className="animate-[drawLine_2s_ease-out_forwards]"
            />
            <defs>
              <linearGradient id="accentGrad" x1="0" y1="0" x2="260" y2="0">
                <stop offset="0%" stopColor="var(--app-accent)" stopOpacity="0.4" />
                <stop offset="50%" stopColor="var(--app-accent)" stopOpacity="1" />
                <stop offset="100%" stopColor="var(--app-accent)" stopOpacity="0.6" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      <h2 className="text-2xl font-bold text-app-text mb-1 tracking-tight">RaceIQ</h2>
      {versionInfo?.current && <div className="text-xs font-mono text-app-text-muted mb-2">v{versionInfo.current}</div>}
      <p className="text-sm text-app-text-muted max-w-sm leading-relaxed">{m.ob_welcome_tagline()}</p>
      <div className="flex items-center gap-2 mt-5">
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">{m.ob_welcome_feature_live()}</span>
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">{m.ob_welcome_feature_compare()}</span>
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">{m.ob_welcome_feature_ai()}</span>
      </div>
      <div className="mt-6 w-full max-w-[220px] text-left">
        <div className="text-xs text-app-text-muted mb-1.5 text-center">{m.label_language()}</div>
        <SearchSelect value={currentLang} onChange={selectLanguage} options={langOptions} placeholder={m.settings_language_search_placeholder()} />
      </div>
    </div>
  );
}
