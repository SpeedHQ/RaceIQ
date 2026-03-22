export function piClass(pi: number): string {
  if (pi <= 0) return "?";
  if (pi < 500) return "D";
  if (pi < 600) return "C";
  if (pi < 700) return "B";
  if (pi < 800) return "A";
  if (pi < 900) return "S";
  return "X";
}

export const PI_COLORS: Record<string, string> = {
  D: "bg-gray-500/20 text-gray-400",
  C: "bg-green-500/20 text-green-400",
  B: "bg-blue-500/20 text-blue-400",
  A: "bg-purple-500/20 text-purple-400",
  S: "bg-amber-500/20 text-amber-400",
  R: "bg-orange-500/20 text-orange-400",
  P: "bg-red-500/20 text-red-400",
  X: "bg-pink-500/20 text-pink-400",
};

export function PiBadge({ pi, showNumber = true }: { pi: number; showNumber?: boolean }) {
  const cls = piClass(pi);
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${PI_COLORS[cls] ?? "bg-app-surface text-app-text-muted"}`}>
      {cls}{showNumber ? pi : ""}
    </span>
  );
}
