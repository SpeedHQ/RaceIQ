import { Button } from "../ui/button";

export function ToggleButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      aria-pressed={active}
      className={`px-2 py-1 text-app-micro uppercase tracking-wider font-semibold rounded border transition-colors ${
        active ? "bg-app-accent/15 border-app-accent/40 text-app-accent" : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
      }`}
    >
      {label}
    </Button>
  );
}
