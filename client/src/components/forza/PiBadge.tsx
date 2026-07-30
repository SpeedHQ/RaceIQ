export function piClass(pi: number): string {
  if (pi <= 0) return "?";
  if (pi >= 999) return "X";
  if (pi >= 901) return "P";
  if (pi >= 801) return "R";
  if (pi >= 701) return "S";
  if (pi >= 601) return "A";
  if (pi >= 501) return "B";
  if (pi >= 401) return "C";
  if (pi >= 301) return "D";
  return "E";
}

export function PiBadge({ pi, showNumber = true }: { pi: number; showNumber?: boolean }) {
  const cls = piClass(pi);
  return (
    <span className="pi-class-badge text-[10px] font-bold px-1.5 py-0.5 rounded" data-pi-class={cls}>
      {cls}
      {showNumber ? pi : ""}
    </span>
  );
}
