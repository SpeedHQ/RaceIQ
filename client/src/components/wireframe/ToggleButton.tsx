export function ToggleButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 text-[9px] uppercase tracking-wider font-semibold rounded border transition-colors ${
        active
          ? "bg-cyan-900/50 border-cyan-700 text-app-accent"
          : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
      }`}
    >
      {label}
    </button>
  );
}
