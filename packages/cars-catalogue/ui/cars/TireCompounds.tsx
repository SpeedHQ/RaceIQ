import type { GameId } from "@raceiq/shared/games/ids";
import { getTireTempGuide } from "@raceiq/shared/racing/live/tire-thresholds";
import { useCarsCatalogueHost } from "../host";

/** Letter shown inside a compound circle. */
const COMPOUND_LETTERS: Record<string, string> = {
  soft: "S",
  medium: "M",
  hard: "H",
  inter: "I",
  wet: "W",
  dry_compound: "D",
  wet_compound: "W",
  default: "·",
};

/** Compounds whose colour token differs from their metadata name. */
const COMPOUND_TOKENS: Record<string, string> = { dry_compound: "soft", wet_compound: "wet" };

const CHANNEL_LABEL_KEY = { carcass: "tire_guide_optimal", surface: "tire_guide_optimal_surface" } as const;

export function CompoundCircle({ compound, className = "" }: { compound: string; className?: string }) {
  return (
    <span
      data-tire-compound={COMPOUND_TOKENS[compound] ?? compound}
      aria-hidden="true"
      className={`tire-compound-wheel inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-app-micro font-bold leading-none ${className}`}
    >
      {COMPOUND_LETTERS[compound] ?? compound.slice(0, 1).toUpperCase()}
    </span>
  );
}

export const LMU_DRY_COMPOUNDS: Record<string, readonly string[]> = {
  HYPERCAR: ["soft", "medium", "hard"],
  LMP2: ["soft", "medium"],
  GT3: ["medium"],
};


/** Coloured compound circles for a car card; nothing when the game publishes no window. */
export function TireCompoundDots({ gameId, className = "" }: { gameId: GameId; className?: string }) {
  const { m } = useCarsCatalogueHost();
  const guide = getTireTempGuide(gameId);
  if (!guide) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`} title={m[CHANNEL_LABEL_KEY[guide.channel]]()}>
      {guide.rows.map((row) => <CompoundCircle key={row.compound} compound={row.compound} />)}
    </div>
  );
}

/** Per-compound optimal window, opened from a car card. */
export function CarTireDialog({
  gameId,
  carName,
  carClass,
  open,
  onOpenChange,
}: {
  gameId: GameId;
  carName: string;
  carClass?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { Dialog, DialogContent, DialogHeader, DialogTitle, m, useUnits } = useCarsCatalogueHost();
  const units = useUnits();
  const guide = getTireTempGuide(gameId);
  if (!guide) return null;
  const compounds = gameId === "lmu" ? LMU_DRY_COMPOUNDS[carClass ?? ""] : undefined;
  const rows = gameId === "lmu"
    ? guide.rows.filter((row) => compounds?.includes(row.compound))
    : guide.rows;
  const optimalHeader = m[CHANNEL_LABEL_KEY[guide.channel]]();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{carName}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-app-text-muted">{m[`tire_guide_description${guide.channel === "surface" ? "_surface" : ""}`]()}</p>
        {gameId === "lmu" && (
          <>
            <p className="text-sm text-app-text-muted">
              {compounds
                ? `Dry compounds for ${carClass}: ${compounds.join(", ")}. Track availability may vary.`
                : `Class-level dry compounds unknown for ${carClass || "Unknown class"}. Track options vary.`}
            </p>
            <p className="text-xs text-app-text-muted">Temperature rows below use the LMU tire temperature guide.</p>
          </>
        )}
        <table className="w-full text-left text-sm tabular-nums">
          <thead>
            <tr className="border-b border-app-border text-app-text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">{m.tire_guide_compound()}</th>
              <th scope="col" className="py-2 font-medium">{optimalHeader} ({units.tempLabel})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.compound} className="border-b border-app-border/60 last:border-0">
                <th scope="row" className="py-2 pr-3 font-medium text-app-text">
                  <span className="flex items-center gap-2">
                    <CompoundCircle compound={row.compound} />
                    {row.compound === "default"
                      ? m.threshold_default_compound()
                      : row.compound.replace(/_compound$/, "").replaceAll("_", " ")}
                  </span>
                </th>
                <td className="py-2 font-mono">
                  {units.temp(row.min).toFixed(0)}–{units.temp(row.max).toFixed(0)} {units.tempLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
