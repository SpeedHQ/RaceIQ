import { useEffect, useRef, useState } from "react";
import { SiDiscord } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { useSaveSettings } from "@/hooks/settings";
import { useRaceIqOnline } from "@/hooks/raceiq-online";
import { m } from "@/paraglide/messages";
import { useTelemetryStore } from "@/stores/telemetry";
import { CommunityStep } from "./steps/CommunityStep";
import { SoundStep } from "./steps/SoundStep";
import { StartupStep } from "./steps/StartupStep";
import { UnitsStep } from "./steps/UnitsStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { OnlineStep } from "./steps/OnlineStep";
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

import { OnlineChoiceStep } from "./steps/OnlineChoiceStep";
import { ProfileStep, type ProfileStepHandle } from "./steps/ProfileStep";
const MODAL_STEPS = [
  { id: "welcome", label: m.step_welcome },
  { id: "access", label: m.access_title },
  { id: "online-choice", label: m.ob_online_choice_title },
  { id: "online-auth", label: m.online_settings_title },
  { id: "online-permissions", label: m.online_onboarding_title },
  { id: "profile", label: m.step_profile },
  { id: "wheel", label: m.label_wheel, Component: WheelStep },
  { id: "units", label: m.label_units, Component: UnitsStep },
  { id: "sound", label: m.label_sound, Component: SoundStep },
  { id: "startup", label: m.step_startup, Component: StartupStep },
  { id: "community", label: m.step_community, Component: CommunityStep },
];
const FLOW_KEY = "raceiq:onboarding-flow";

function restoredStep(): string {
  try {
    const saved = JSON.parse(sessionStorage.getItem(FLOW_KEY) ?? "null") as { path?: string; choice?: string; step?: string } | null;
    if (saved?.path === location.pathname && saved.choice === "discord" && (saved.step === "online-auth" || saved.step === "online-permissions")) return saved.step;
  } catch { /* ignore invalid or unavailable storage */ }
  return "welcome";
}

export function OnboardingModal({ onClose, onComplete, initialStep = 0 }: { onClose?: () => void; onComplete?: () => Promise<void>; initialStep?: number } = {}) {
  const { status, refresh } = useDashboardAuth();
  const restored = restoredStep();
  const [stepId, setStepId] = useState(() => initialStep === 1 ? "access" : restored);
  const [choice, setChoice] = useState<"welcome" | "discord" | "offline">(() => restored === "welcome" ? "welcome" : "discord");
  const [cancelError, setCancelError] = useState(false);
  const [accessFooter, setAccessFooter] = useState<HTMLSpanElement | null>(null);
  const profileHandle = useRef<ProfileStepHandle | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const onlineFlow = stepId === "online-auth" || stepId === "online-permissions" || (stepId === "profile" && choice === "discord");
  const online = useRaceIqOnline({ enabled: onlineFlow });
  const saveSettings = useSaveSettings();
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const udpPps = useTelemetryStore((s) => s.udpPps);
  const lastUdpAt = useTelemetryStore((s) => s.lastUdpAt);
  const receiving = udpPps > 0 || packetsPerSec > 0 || lastUdpAt > 0;
  const step = MODAL_STEPS.findIndex(({ id }) => id === stepId);
  const current = MODAL_STEPS[step]!;
  const StepComponent = "Component" in current ? current.Component : undefined;
  const progressSteps = MODAL_STEPS.filter(({ id }) => id !== "welcome" && id !== "access" && id !== "online-choice" && (choice === "discord" || (id !== "online-auth" && id !== "online-permissions")));
  const activeProgressIndex = progressSteps.findIndex(({ id }) => id === stepId);
  async function navigateTo(id: string) {
    if (stepId === "profile" && !(await profileHandle.current?.save())) return;
    setStepId(id);
  }
  function setProfileHandle(handle: ProfileStepHandle | null) { profileHandle.current = handle; }
  useEffect(() => {
    if (status.pending && stepId !== "welcome" && stepId !== "access") setStepId("access");
    else if (!status.pending && stepId === "access") setStepId("online-choice");
  }, [status.pending, stepId]);
  useEffect(() => {
    if (stepId !== "online-auth" || online.state?.connection.status !== "connected") return;
    setStepId("online-permissions");
    try { sessionStorage.setItem(FLOW_KEY, JSON.stringify({ path: location.pathname, choice: "discord", step: "online-permissions" })); } catch { /* storage optional */ }
  }, [online.state?.connection.status, stepId]);
  useEffect(() => {
    if (stepId !== "online-permissions" || !online.state || online.state.connection.status === "connected") return;
    setOnlineStep("online-auth");
  }, [online.state?.connection.status, stepId]);
  function setOnlineStep(id: "online-auth" | "online-permissions") {
    setChoice("discord");
    setStepId(id);
    try { sessionStorage.setItem(FLOW_KEY, JSON.stringify({ path: location.pathname, choice: "discord", step: id })); } catch { /* storage optional */ }
  }
  function chooseDiscord() {
    setCancelError(false);
    setOnlineStep("online-auth");
    void online.connect();
  }
  async function chooseOffline() {
    if (online.state?.connection.status === "signing_in") {
      const result = await online.cancelSignIn();
      if (!result?.ok) { setCancelError(true); return; }
    }
    setChoice("offline");
    try { sessionStorage.removeItem(FLOW_KEY); } catch { /* storage optional */ }
    setStepId("profile");
  }
  async function leaveOnline() {
    if (online.state?.connection.status === "signing_in") {
      const result = await online.cancelSignIn();
      if (!result?.ok) { setCancelError(true); return; }
    }
    try { sessionStorage.removeItem(FLOW_KEY); } catch { /* storage optional */ }
    setChoice("welcome");
    setStepId("online-choice");
  }
  function finishPermissions() {
    try { sessionStorage.removeItem(FLOW_KEY); } catch { /* storage optional */ }
    setStepId("profile");
  }
  async function handleFinish() {
    try { sessionStorage.removeItem(FLOW_KEY); } catch { /* storage optional */ }
    if (onClose) onClose();
    else {
      await saveSettings.mutateAsync({ onboardingComplete: true });
      await onComplete?.();
    }
  }
  return (
    <div className="@container/onboarding fixed inset-0 z-50 flex items-center justify-center bg-app-bg p-4">
      <div className="flex h-auto max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl">
        {stepId !== "welcome" && stepId !== "online-choice" && <div className="shrink-0 px-4 pb-4 pt-4 @3xl/onboarding:px-6 @3xl/onboarding:pt-6">
          <h1 className="text-app-heading font-semibold text-app-text @3xl/onboarding:text-app-title">{m.ob_configure_title()}</h1>
          <div className="mt-4 flex items-center gap-2 overflow-x-auto pb-1">
            {progressSteps.map((item, index) => {
              const isCurrent = item.id === stepId;
              const isComplete = index < activeProgressIndex;
              return <div key={item.id} className="flex shrink-0 items-center gap-2">
                <div className={`flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${isCurrent ? "text-app-accent" : isComplete ? "text-app-text-secondary" : "text-app-text-muted/50"}`}>
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold ${isCurrent ? "border-app-accent bg-app-accent/15 text-app-accent" : isComplete ? "border-status-success bg-status-success/15 text-status-success" : "border-app-border bg-app-surface-alt text-app-text-muted/50"}`}>{isComplete ? <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg> : index + 1}</span>
                  {item.label()}
                </div>
                {index < progressSteps.length - 1 && <div className={`h-px w-8 ${isComplete ? "bg-status-success/50" : "bg-app-border"}`} />}
              </div>;
            })}
          </div>
        </div>}
        <div className="min-h-[280px] flex-1 overflow-y-auto border-t border-app-border px-4 py-5 @3xl/onboarding:px-6">
          {stepId === "welcome" ? <WelcomeStep setup={status.pending} />
            : stepId === "access" && status.pending ? <div className="flex flex-col gap-4">
              <p>{status.upgrade ? m.access_upgrade() : m.access_setup_description()}</p>
              <AccessSetupForm setup submitContainer={accessFooter} language={getLocale()} onComplete={async () => {
                await refresh();
                setStepId("online-choice");
              }} />
            </div>
            : stepId === "access" ? <AccessStep />
            : stepId === "online-choice" ? <OnlineChoiceStep selected={choice === "welcome" ? null : choice} onSelect={setChoice} />
              : stepId === "online-auth" ? <OnlineStep stage="auth" onSkip={() => void chooseOffline()} />
                : stepId === "online-permissions" ? <OnlineStep stage="permissions" onComplete={finishPermissions} onSkip={() => void chooseOffline()} />
                  : stepId === "profile" ? <ProfileStep onlineIntent={choice === "discord"} onlineState={online.state} canMutate={online.canMutate} setDisplayName={online.setDisplayName} handleRef={setProfileHandle} onSavingChange={setProfileSaving} />
                    : StepComponent ? <StepComponent /> : null}
        </div>
        {stepId === "welcome" && <footer className="flex shrink-0 justify-end border-t border-app-border bg-app-surface-alt/30 px-4 py-4 @3xl/onboarding:px-6">
          <Button className="min-h-11 w-full sm:w-auto" variant="app-primary" onClick={() => setStepId(status.pending ? "access" : "online-choice")}>{m.common_get_started()}</Button>
        </footer>}
        {stepId === "online-choice" && <footer className="flex shrink-0 flex-col gap-3 border-t border-app-border bg-app-surface-alt/30 px-4 py-4 sm:flex-row sm:items-center sm:justify-between @3xl/onboarding:px-6">
          <Button className="min-h-11 self-start" variant="outline" onClick={() => setStepId(status.pending ? "access" : "welcome")}>{m.common_back()}</Button>
          <Button className="min-h-11" variant="app-primary" disabled={choice === "welcome"} onClick={() => { if (choice === "discord") chooseDiscord(); else if (choice === "offline") void chooseOffline(); }}>
            {choice === "discord" && <SiDiscord className="h-4 w-4 shrink-0" aria-hidden="true" />}
            {choice === "discord" ? m.ob_continue_discord() : choice === "offline" ? m.ob_continue_offline() : m.common_next()}
          </Button>
        </footer>}
        {stepId === "access" && status.pending ? <div data-slot="onboarding-footer" className="flex shrink-0 items-center justify-end border-t border-app-border bg-app-surface-alt/30 px-4 py-4 @3xl/onboarding:px-6"><div className="flex items-center gap-2"><Button variant="outline" size="sm" onClick={() => setStepId("welcome")}>{m.common_back()}</Button><span ref={setAccessFooter} /></div></div>
          : stepId !== "welcome" && stepId !== "online-choice" && stepId !== "online-auth" && stepId !== "online-permissions" && <div className="flex shrink-0 items-center justify-end border-t border-app-border bg-app-surface-alt/30 px-4 py-4 @3xl/onboarding:px-6">
          <div className="flex items-center gap-2">
            {step > 0 && <Button variant="outline" size="sm" disabled={profileSaving} onClick={() => void navigateTo(progressSteps[activeProgressIndex - 1]?.id ?? "online-choice")}>{m.common_back()}</Button>}
            {step < MODAL_STEPS.length - 1
              ? <Button variant="app-primary" size="sm" disabled={profileSaving || (stepId === "profile" && choice === "discord" && !online.canMutate)} onClick={() => void navigateTo(progressSteps[activeProgressIndex + 1]!.id)}>{profileSaving ? m.ob_profile_saving() : m.common_next()}</Button>
              : <Button size="sm" variant={receiving ? "default" : "outline"} onClick={handleFinish} disabled={saveSettings.isPending}>{receiving ? m.common_finish() : m.common_next()}</Button>}
          </div>
        </div>}
        {stepId === "online-auth" && <div className="flex shrink-0 flex-col items-start gap-2 border-t border-app-border bg-app-surface-alt/30 px-4 py-4 @3xl/onboarding:px-6">{cancelError && <p role="alert" className="text-sm text-status-danger">{m.online_transport_error()}</p>}<Button variant="outline" size="sm" disabled={online.isMutating} onClick={() => { setCancelError(false); void leaveOnline(); }}>{m.common_back()}</Button></div>}
      </div>
    </div>
  );
}
