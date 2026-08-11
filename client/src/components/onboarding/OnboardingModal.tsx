import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSaveSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { useTelemetryStore } from "@/stores/telemetry";
import { CommunityStep } from "./steps/CommunityStep";
import { ProfileStep } from "./steps/ProfileStep";
import { SoundStep } from "./steps/SoundStep";
import { StartupStep } from "./steps/StartupStep";
import { UnitsStep } from "./steps/UnitsStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { WheelStep } from "./steps/WheelStep";

const MODAL_STEPS = [
  { id: "welcome", label: m.step_welcome, Component: WelcomeStep },
  { id: "profile", label: m.step_profile, Component: ProfileStep },
  { id: "wheel", label: m.label_wheel, Component: WheelStep },
  { id: "units", label: m.label_units, Component: UnitsStep },
  { id: "sound", label: m.label_sound, Component: SoundStep },
  { id: "startup", label: m.step_startup, Component: StartupStep },
  { id: "community", label: m.step_community, Component: CommunityStep },
];

export function OnboardingModal({ onClose }: { onClose?: () => void } = {}) {
  const [step, setStep] = useState(0);
  const saveSettings = useSaveSettings();
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const udpPps = useTelemetryStore((s) => s.udpPps);
  const lastUdpAt = useTelemetryStore((s) => s.lastUdpAt);
  const receiving = udpPps > 0 || packetsPerSec > 0 || lastUdpAt > 0;
  const { Component: StepComponent } = MODAL_STEPS[step];
  function handleFinish() {
    if (onClose) onClose();
    else saveSettings.mutate({ onboardingComplete: true } as never);
  }
  return (
    <div className="@container/onboarding fixed inset-0 z-50 flex items-center justify-center bg-app-bg p-4">
      <div className="flex h-auto max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl">
        {step > 0 && (
          <div className="shrink-0 px-4 pt-4 pb-4 @3xl/onboarding:px-6 @3xl/onboarding:pt-6">
            <h1 className="text-app-heading font-semibold text-app-text @3xl/onboarding:text-app-title">{m.ob_configure_title()}</h1>
            <div className="flex items-center gap-2 mt-4 overflow-x-auto pb-1">
              {MODAL_STEPS.slice(1).map((s, idx) => {
                const i = idx + 1;
                return (
                  <div key={s.id} className="flex items-center gap-2 shrink-0">
                    <div
                      className={`flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${i === step ? "text-app-accent" : i < step ? "text-app-text-secondary" : "text-app-text-muted/50"}`}
                    >
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold border transition-colors ${i === step ? "border-app-accent bg-app-accent/15 text-app-accent" : i < step ? "border-status-success bg-status-success/15 text-status-success" : "border-app-border bg-app-surface-alt text-app-text-muted/50"}`}
                      >
                        {i < step ? (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          idx + 1
                        )}
                      </span>
                      {s.label()}
                    </div>
                    {idx < MODAL_STEPS.length - 2 && <div className={`w-8 h-px ${i < step ? "bg-status-success/50" : "bg-app-border"}`} />}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="min-h-[280px] flex-1 overflow-y-auto border-t border-app-border px-4 py-5 @3xl/onboarding:px-6">
          <StepComponent />
        </div>
        <div className="flex shrink-0 items-center justify-end border-t border-app-border bg-app-surface-alt/30 px-4 py-4 @3xl/onboarding:px-6">
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>
                {m.common_back()}
              </Button>
            )}
            {step < MODAL_STEPS.length - 1 ? (
              <Button variant="app-primary" size="sm" onClick={() => setStep((s) => s + 1)}>
                {step === 0 ? m.common_get_started() : m.common_next()}
              </Button>
            ) : (
              <Button size="sm" variant={receiving ? "default" : "outline"} onClick={handleFinish} disabled={saveSettings.isPending}>
                {receiving ? m.common_finish() : m.common_next()}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
