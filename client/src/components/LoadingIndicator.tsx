interface LoadingIndicatorProps {
  label: string;
}

/** Compact loading status; the localized label remains available to screen readers. */
export function LoadingIndicator({ label }: LoadingIndicatorProps) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center justify-center text-app-accent">
      <span aria-hidden="true" className="size-5 rounded-full border-2 border-app-border-input border-t-app-accent motion-safe:animate-spin" />
    </span>
  );
}
