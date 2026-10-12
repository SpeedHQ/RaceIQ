import { OnlineSection } from "@/components/settings/OnlineSection";

export function OnlineStep({ stage, onSkip, onComplete }: { stage: "auth" | "permissions"; onSkip: () => void; onComplete?: () => void }) {
  return <OnlineSection onboarding stage={stage} onSkip={onSkip} onComplete={onComplete} />;
}
