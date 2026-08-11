import { m } from "@/paraglide/messages";
import { AiAnalysisSection } from "./AiAnalysisSection";
import { AiAutoTuneSection } from "./AiAutoTuneSection";
import { AiChatSection } from "./AiChatSection";
import { AiDriverProfileSection } from "./AiDriverProfileSection";
import { useAiSettings } from "./useAiSettings";

export function AiSection() {
  const { settingsLoaded, analysis, chat, autoTune, driverProfile } = useAiSettings();

  if (!settingsLoaded) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-app-text mb-4">{m.ai_settings_title()}</h2>
        <div className="max-w-xs rounded border border-app-border-input bg-app-surface px-3 py-2 text-xs text-app-text-muted">{m.ai_settings_loading()}</div>
      </section>
    );
  }
  return (
    <section>
      <AiAnalysisSection state={analysis} />
      <AiChatSection state={chat} />
      <AiAutoTuneSection state={autoTune} />
      <AiDriverProfileSection state={driverProfile} />
    </section>
  );
}
