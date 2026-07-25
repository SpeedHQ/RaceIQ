import { ChevronLeft } from "lucide-react";

/**
 * BackButton — one consistent back affordance for the tuning workspace (list ↔
 * session). Same styling everywhere; callers supply the click handler and label.
 * TODO(i18n): label is plain text for now — localise when the tuning UI strings
 * are moved to paraglide.
 */
export function BackButton({ onClick, label = "Tuning sessions", className = "" }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-0.5 text-xs text-app-text-dim hover:text-app-text ${className}`}>
      <ChevronLeft className="size-3.5" />
      {label}
    </button>
  );
}
