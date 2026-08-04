import { useState } from "react";
import { Button } from "@/components/ui/button";
import { isDevelopment } from "@/lib/env";
import { m } from "@/paraglide/messages";
import { useUiStore } from "@/stores/ui";
import { AboutSection } from "./AboutSection";
import { AiSection } from "./AiSection";
import { ConnectionSection } from "./connection/ConnectionSection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { ExtractionSection } from "./ExtractionSection";
import { F1ExtractionSection } from "./F1ExtractionSection";
import { GamesSection } from "./GamesSection";
import { GeneralSection } from "./general/GeneralSection";
import { NAV_ITEMS, NAV_LABELS, type SectionId } from "./navigation";
import { StorageSection } from "./StorageSection";
import { SoundSection } from "./sound/SoundSection";
import { SpeedSection } from "./speed/SpeedSection";
import { UpdatesSection } from "./UpdatesSection";
import { WheelSection } from "./wheel/WheelSection";

export function Settings({ initialSection, onClose }: { initialSection?: SectionId; onClose?: () => void } = {}) {
  const { openOnboarding } = useUiStore();
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? "general");

  return (
    <div className="@container/settings flex h-full flex-col @3xl/settings:flex-row">
      {/* Nav — horizontal tabs in narrow settings views, sidebar when space allows */}
      <nav className="flex shrink-0 overflow-x-auto border-b border-app-border bg-app-surface-alt/50 py-2 @3xl/settings:w-48 @3xl/settings:flex-col @3xl/settings:overflow-x-visible @3xl/settings:border-r @3xl/settings:border-b-0">
        {NAV_ITEMS.filter((item) => !("devOnly" in item) || isDevelopment).map((item) => (
          <Button variant={activeSection === item.id ? "settings-nav-selected" : "settings-nav"} size="app-md" key={item.id} onClick={() => setActiveSection(item.id)}>
            {(NAV_LABELS[item.id] ?? (() => item.label))()}
          </Button>
        ))}
        <div className="mx-2 mt-auto hidden border-t border-app-border pt-2 @3xl/settings:block">
          <Button
            variant="full-width-action"
            size="app-md"
            onClick={() => {
              onClose?.();
              openOnboarding();
            }}
          >
            {m.settings_setup_wizard()}
          </Button>
        </div>
        <Button
          variant="app-ghost"
          size="app-md"
          className="ml-auto shrink-0 whitespace-nowrap @3xl/settings:hidden"
          onClick={() => {
            onClose?.();
            openOnboarding();
          }}
        >
          {m.settings_setup_wizard()}
        </Button>
      </nav>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto p-4 @3xl/settings:p-6">
        {activeSection === "general" && <GeneralSection />}

        {activeSection === "games" && <GamesSection />}

        {activeSection === "connection" && <ConnectionSection />}

        {activeSection === "wheel" && <WheelSection />}

        {activeSection === "speed" && <SpeedSection />}

        {activeSection === "sound" && <SoundSection />}
        {activeSection === "storage" && <StorageSection />}
        {activeSection === "ai" && <AiSection />}
        {activeSection === "developer" && (
          <div className="space-y-8">
            <ExtractionSection />
            <F1ExtractionSection />
          </div>
        )}
        {activeSection === "diagnostics" && <DiagnosticsSection />}
        {activeSection === "updates" && <UpdatesSection />}
        {activeSection === "about" && <AboutSection />}
      </div>
    </div>
  );
}
