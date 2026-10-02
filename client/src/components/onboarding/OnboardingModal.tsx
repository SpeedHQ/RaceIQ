import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSaveSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { useTelemetryStore } from "@/stores/telemetry";
import { ConnectionSection } from "@/components/settings/connection/ConnectionSection";
import { ProfileStep } from "./steps/ProfileStep";
import { UnitsStep } from "./steps/UnitsStep";
import { WelcomeStep } from "./steps/WelcomeStep";

const STEPS = [
  { id: "welcome", label: m.ob_install_step_welcome, Component: WelcomeStep },
  { id: "essentials", label: m.ob_install_step_essentials, Component: EssentialsStep },
  { id: "connection", label: m.ob_install_step_connection, Component: ConnectionStep },
  { id: "ready", label: m.ob_install_step_ready, Component: ReadyStep },
];

function EssentialsStep() {
  return <div className="space-y-8"><ProfileStep /><UnitsStep /></div>;
}

function ConnectionStep() {
  return (
    <div className="space-y-6">
      <ConnectionSection setupOnly />
      <section className="border-t border-app-border pt-4">
        <h2 className="text-lg font-semibold text-app-text">ACC / Assetto Corsa Evo / iRacing</h2>
        <p className="mt-2 text-sm text-app-text-secondary">{m.ob_install_native_connection()}</p>
      </section>
    </div>
  );
}

function ReadyStep() {
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const udpPps = useTelemetryStore((s) => s.udpPps);
  const receiving = udpPps > 0 || packetsPerSec > 0;
  return (
    <div className="py-6">
      <h2 className="text-xl font-semibold text-app-text">{m.ob_install_ready_title()}</h2>
      <p className="mt-2 text-sm text-app-text-muted">{receiving ? m.ob_install_ready_receiving() : m.ob_install_ready_offline()}</p>
    </div>
  );
}

export function OnboardingModal({ onClose, onStartWalkthrough }: { onClose?: () => void; onStartWalkthrough?: () => void } = {}) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const saveSettings = useSaveSettings();
  const StepComponent = STEPS[step].Component;

  async function finish(walkthrough = false) {
    if (onClose && !walkthrough) {
      onClose();
      return;
    }
    setError(null);
    try {
      await saveSettings.mutateAsync({ onboardingComplete: true } as never);
      const url = new URL(window.location.href);
      if (url.searchParams.has("welcome")) {
        url.searchParams.delete("welcome");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
      if (walkthrough) onStartWalkthrough?.();
      else onClose?.();
    } catch {
      setError(m.ob_install_save_error());
    }
  }

  const pending = saveSettings.isPending;
  return (
    <div className="@container/onboarding fixed inset-0 z-50 flex items-center justify-center bg-app-bg p-4">
      <div className="flex h-auto max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl">
        <div className="shrink-0 px-4 pt-4 pb-4 @3xl/onboarding:px-6 @3xl/onboarding:pt-6">
          <h1 className="text-app-heading font-semibold text-app-text @3xl/onboarding:text-app-title">{m.ob_install_title()}</h1>
          <div className="mt-4 flex items-center gap-2 overflow-x-auto pb-1" aria-label={m.ob_install_progress()}>
            {STEPS.map((s, idx) => (
              <div key={s.id} className="flex shrink-0 items-center gap-2">
                <span aria-current={idx === step ? "step" : undefined} className={`text-xs font-medium whitespace-nowrap ${idx === step ? "text-app-accent" : "text-app-text-muted"}`}>
                  {idx + 1}. {s.label()}
                </span>
                {idx < STEPS.length - 1 && <div className="h-px w-8 bg-app-border" />}
              </div>
            ))}
          </div>
        </div>
        <div className="min-h-[280px] flex-1 overflow-y-auto border-t border-app-border px-4 py-5 @3xl/onboarding:px-6">
          <StepComponent />
          {error && <p role="alert" className="mt-4 text-sm text-status-danger">{error}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-app-border bg-app-surface-alt/30 px-4 py-4 @3xl/onboarding:px-6">
          <div className="flex items-center gap-2">
            {step > 0 && <Button variant="outline" size="sm" disabled={pending} onClick={() => setStep((s) => s - 1)}>{m.common_back()}</Button>}
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => void finish(false)}>{m.ob_install_skip()}</Button>
          </div>
          {step < STEPS.length - 1 ? (
            <Button variant="app-primary" size="sm" disabled={pending} onClick={() => setStep((s) => s + 1)}>{m.common_next()}</Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={pending} onClick={() => void finish(false)}>{m.ob_install_explore()}</Button>
              <Button variant="app-primary" size="sm" disabled={pending} onClick={() => void finish(true)}>{pending ? m.ob_install_saving() : m.ob_install_walkthrough()}</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
