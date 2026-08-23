import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { isDevelopment } from "@/lib/env";
import { m } from "@/paraglide/messages";
import { uiStore } from "@/stores/ui";
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
  const { openOnboarding } = uiStore.actions;
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? "general");
  const filteredNavItems = NAV_ITEMS.filter((item) => !("devOnly" in item) || isDevelopment);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="@container/settings flex h-full flex-col md:flex-row">
      <div className="flex shrink-0 items-center justify-between border-b border-app-border bg-app-surface-alt/50 px-3 py-2 md:hidden">
        <span className="text-app-body font-medium text-app-text">{(NAV_LABELS[activeSection] ?? (() => ""))()}</span>
        <Button
          variant="app-ghost"
          size="icon-sm"
          aria-label={mobileMenuOpen ? m.common_close() : "Open settings menu"}
          onClick={() => setMobileMenuOpen((open) => !open)}
        >
          {mobileMenuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </Button>
      </div>

      <nav
        className={`${mobileMenuOpen ? "flex" : "hidden"} shrink-0 flex-col overflow-y-auto border-b border-app-border bg-app-surface-alt/50 py-2 md:flex md:w-48 md:overflow-visible md:border-r md:border-b-0`}
      >
        {filteredNavItems.map((item) => (
          <Button
            variant={activeSection === item.id ? "settings-nav-selected" : "settings-nav"}
            size="app-md"
            key={item.id}
            onClick={() => {
              setActiveSection(item.id);
              setMobileMenuOpen(false);
            }}
          >
            {(NAV_LABELS[item.id] ?? (() => item.label))()}
          </Button>
        ))}
        <div className="mx-2 mt-auto hidden border-t border-app-border pt-2 md:block">
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
        <div className="mx-2 border-t border-app-border pt-2 md:hidden">
          <Button
            variant="app-ghost"
            size="app-md"
            className="w-full justify-start"
            onClick={() => {
              setMobileMenuOpen(false);
              onClose?.();
              openOnboarding();
            }}
          >
            {m.settings_setup_wizard()}
          </Button>
        </div>
      </nav>

      {/* Right content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
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
