import { piClass } from "@raceiq/frontend-pure/pi-class";

export function PiBadge({ pi, showNumber = true }: { pi: number; showNumber?: boolean }) {
  const cls = piClass(pi);
  return (
    <span className="pi-class-badge text-app-caption font-bold px-1.5 py-0.5 rounded" data-pi-class={cls}>
      {cls}
      {showNumber ? pi : ""}
    </span>
  );
}
