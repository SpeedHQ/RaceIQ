interface PointerPosition {
  x: number;
  y: number;
}

export function PointerLoadingIndicator({
  loading,
  position,
  label,
}: {
  loading: boolean;
  position: PointerPosition | null;
  label: string;
}) {
  if (!loading || !position) return null;
  return (
    <div
      className="pointer-loading-indicator pointer-events-none fixed z-[100] rounded bg-app-surface px-1.5 py-1 text-app-caption text-app-text shadow"
      style={{ left: position.x + 12, top: position.y - 12 }}
      role="status"
      aria-label={label}
    >
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="inline-block size-3 rounded-full border border-app-border-input border-t-app-accent animate-spin" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}
