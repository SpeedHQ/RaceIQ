import { ChevronLeft } from "lucide-react";
import { Button } from "../ui/button";

/**
 * BackButton — one consistent back affordance for the tuning workspace (list ↔
 * session). Same styling everywhere; callers supply the click handler and label.
 * TODO(i18n): label is plain text for now — localise when the tuning UI strings
 * are moved to paraglide.
 */
export function BackButton({ onClick, label = "Experiments", className = "" }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <Button type="button" variant="app-ghost" size="app-sm" onClick={onClick} className={`!h-auto !px-0 inline-flex items-center gap-0.5 text-xs text-app-text-dim hover:text-app-text ${className}`}>
      <ChevronLeft className="size-3.5" />
      {label}
    </Button>
  );
}
