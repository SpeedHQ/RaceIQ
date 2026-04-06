import { createFileRoute, Outlet, useNavigate, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { markOnboardingComplete } from "../components/Onboarding";
import { useTelemetryStore } from "../stores/telemetry";

const STEPS = [
  { path: "/onboarding/welcome", label: "Welcome" },
  { path: "/onboarding/profile", label: "Profile" },
  { path: "/onboarding/wheel", label: "Wheel" },
  { path: "/onboarding/units", label: "Units" },
  { path: "/onboarding/sound", label: "Sound" },
  { path: "/onboarding/community", label: "Community" },
] as const;

function OnboardingLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentIdx = STEPS.findIndex((s) => s.path === location.pathname);
  const step = currentIdx === -1 ? 0 : currentIdx;
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const udpPps = useTelemetryStore((s) => s.udpPps);
  const lastUdpAt = useTelemetryStore((s) => s.lastUdpAt);
  const receiving = udpPps > 0 || packetsPerSec > 0 || lastUdpAt > 0;

  // Redirect bare /onboarding to /onboarding/welcome
  useEffect(() => {
    if (location.pathname === "/onboarding") {
      navigate({ to: "/onboarding/welcome", replace: true });
    }
  }, [location.pathname]);

  function handleNext() {
    if (step < STEPS.length - 1) {
      navigate({ to: STEPS[step + 1].path });
    }
  }

  function handleBack() {
    if (step > 0) {
      navigate({ to: STEPS[step - 1].path });
    }
  }

  function handleFinish() {
    markOnboardingComplete();
    navigate({ to: "/" });
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-app-bg p-4">
      <div className="w-full max-w-3xl rounded-xl border border-app-border bg-app-surface shadow-2xl overflow-hidden">
        {/* Header — hidden on welcome */}
        {step > 0 && (
          <div className="px-6 pt-6 pb-4">
            <h1 className="text-lg font-semibold text-app-text">
              Configure your telemetry dashboard
            </h1>

            {/* Step dots — skip Welcome (index 0) */}
            <div className="flex items-center gap-2 mt-4">
              {STEPS.slice(1).map((s, idx) => {
                const i = idx + 1;
                return (
                  <div key={s.path} className="flex items-center gap-2">
                    <button
                      onClick={() => navigate({ to: s.path })}
                      className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
                        i === step
                          ? "text-app-accent"
                          : i < step
                            ? "text-app-text-secondary"
                            : "text-app-text-muted/50"
                      }`}
                    >
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold border transition-colors ${
                          i === step
                            ? "border-app-accent bg-app-accent/15 text-app-accent"
                            : i < step
                              ? "border-emerald-500 bg-emerald-500/15 text-emerald-400"
                              : "border-app-border bg-app-surface-alt text-app-text-muted/50"
                        }`}
                      >
                        {i < step ? (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          idx + 1
                        )}
                      </span>
                      {s.label}
                    </button>
                    {idx < STEPS.length - 2 && (
                      <div className={`w-8 h-px ${i < step ? "bg-emerald-500/50" : "bg-app-border"}`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="px-6 py-5 min-h-[280px] border-t border-app-border">
          <Outlet />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-app-border bg-app-surface-alt/30">
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={handleBack}>
                Back
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button size="sm" onClick={handleNext}>
                {step === 0 ? "Get Started" : "Next"}
              </Button>
            ) : (
              <Button size="sm" variant={receiving ? "default" : "outline"} onClick={handleFinish}>
                {receiving ? "Finish" : "Next"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/onboarding")({
  component: OnboardingLayout,
});
