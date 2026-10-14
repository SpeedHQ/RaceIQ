import { useIsMutating } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/query-keys";
import { UnitsStep } from "./steps/UnitsStep";
import { useRecordingDirectoryStatus, useRecordingLayoutMigration } from "@/hooks/recording-storage";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSaveSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { useTelemetryStore } from "@/stores/telemetry";
import { CommunityStep } from "./steps/CommunityStep";
import { ProfileStep } from "./steps/ProfileStep";
import { SoundStep } from "./steps/SoundStep";
import { StartupStep } from "./steps/StartupStep";
import { StorageStep } from "./steps/StorageStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { WheelStep } from "./steps/WheelStep";
import { AccessSetupForm } from "@/components/security/AccessSetupForm";
import { useDashboardAuth } from "@/lib/dashboard-auth";
import { getLocale } from "@/paraglide/runtime";

function AccessStep() {
  return (
    <div className="flex flex-col gap-4">
      <h2>{m.access_title()}</h2>
      <p>{m.access_configured()}</p>
    </div>
  );
}

const MODAL_STEPS = [
  { id: "welcome", label: m.step_welcome, Component: WelcomeStep },
  { id: "access", label: m.access_title, Component: AccessStep },
  { id: "profile", label: m.step_profile, Component: ProfileStep },
  { id: "wheel", label: m.label_wheel, Component: WheelStep },
  { id: "units", label: m.label_units, Component: UnitsStep },
  { id: "sound", label: m.label_sound, Component: SoundStep },
  { id: "startup", label: m.step_startup, Component: StartupStep },
  { id: "storage", label: m.label_storage, Component: StorageStep },
  { id: "community", label: m.step_community, Component: CommunityStep },
];

export function OnboardingModal({ onClose, onComplete, initialStep = 0 }: { onClose?: () => void; onComplete?: () => Promise<void>; initialStep?: number } = {}) {
  const { status, refresh } = useDashboardAuth();
  const [step, setStep] = useState(initialStep);
  const [accessFooter, setAccessFooter] = useState<HTMLSpanElement | null>(null);
  const saveSettings = useSaveSettings();
  const storageStatus = useRecordingDirectoryStatus();
  const isMovePending = useIsMutating({ mutationKey: queryKeys.recordingDirectoryMove }) > 0;
  const layoutMigration = useRecordingLayoutMigration();
  const isLayoutPending = useIsMutating({ mutationKey: queryKeys.recordingLayoutMigrationStart }) > 0;
  const isSelectPending = useIsMutating({ mutationKey: queryKeys.recordingDirectorySelect }) > 0;
  const layoutBusy = layoutMigration.data?.progress.status === "running" || Boolean(layoutMigration.data?.destinationDirectory && layoutMigration.data.progress.status !== "success");
  const storageBusy = isMovePending || isLayoutPending || isSelectPending || storageStatus.data?.state === "moving" || layoutBusy;
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const udpPps = useTelemetryStore((s) => s.udpPps);
  const lastUdpAt = useTelemetryStore((s) => s.lastUdpAt);
  const receiving = udpPps > 0 || packetsPerSec > 0 || lastUdpAt > 0;
  const { Component: StepComponent } = MODAL_STEPS[step];
  async function handleFinish() {
    if (onClose) onClose();
    else {
      await saveSettings.mutateAsync({ onboardingComplete: true });
      await onComplete?.();
    }
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
                    <div className={`flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${i === step ? "text-app-accent" : i < step ? "text-app-text-secondary" : "text-app-text-muted/50"}`}>
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold border transition-colors ${i === step ? "border-app-accent bg-app-accent/15 text-app-accent" : i < step ? "border-status-success bg-status-success/15 text-status-success" : "border-app-border bg-app-surface-alt text-app-text-muted/50"}`}>
                        {i < step ? (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                        ) : idx + 1}
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
          {step === 0 ? <WelcomeStep setup={status.pending} /> : step === 1 && status.pending ? (
            <div className="flex flex-col gap-4">
              <p>{status.upgrade ? m.access_upgrade() : m.access_setup_description()}</p>
              <AccessSetupForm setup submitContainer={accessFooter} language={getLocale()} onComplete={async () => { await refresh(); setStep((current) => current + 1); }} />
            </div>
          ) : <StepComponent />}
        </div>
        <div data-slot="onboarding-footer" className="flex shrink-0 items-center justify-end border-t border-app-border bg-app-surface-alt/30 px-4 py-4 @3xl/onboarding:px-6">
          <div className="flex items-center gap-2">
            {step > 0 && <Button variant="outline" size="sm" disabled={storageBusy} onClick={() => setStep((s) => s - 1)}>{m.common_back()}</Button>}
            {step === 1 && status.pending ? <span ref={setAccessFooter} /> : step < MODAL_STEPS.length - 1 ? (
              <Button variant="app-primary" size="sm" disabled={storageBusy} onClick={() => setStep((s) => s + 1)}>{step === 0 ? m.common_get_started() : m.common_next()}</Button>
            ) : (
              <Button size="sm" variant={receiving ? "default" : "outline"} onClick={handleFinish} disabled={saveSettings.isPending || storageBusy}>{receiving ? m.common_finish() : m.common_next()}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
