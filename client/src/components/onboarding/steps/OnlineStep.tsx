import { OnlineSection } from "@/components/settings/OnlineSection";

export function OnlineStep({ onSkip = () => undefined }: { onSkip?: () => void } = {}) {
  return <OnlineSection onboarding onSkip={onSkip} />;
}
