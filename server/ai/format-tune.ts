import type { TuneSettings, TuneCategory } from "../../shared/types";

interface TuneForPrompt {
  name: string;
  author: string;
  category: TuneCategory;
  settings: TuneSettings;
}

export function formatTuneForPrompt(tune: TuneForPrompt): string {
  const s = tune.settings;
  const lines: string[] = [];

  lines.push(`--- ACTIVE TUNE: "${tune.name}" by ${tune.author} (${tune.category}) ---`);

  const compound = s.tires.compound ? ` (${s.tires.compound})` : "";
  lines.push(`Tires: Front ${s.tires.frontPressure} PSI, Rear ${s.tires.rearPressure} PSI${compound}`);

  const ratios = s.gearing.ratios ? `, Ratios: [${s.gearing.ratios.join(", ")}]` : "";
  lines.push(`Gearing: Final Drive ${s.gearing.finalDrive}${ratios}`);

  const caster = s.alignment.frontCaster != null ? `, Caster ${s.alignment.frontCaster}°` : "";
  lines.push(`Alignment: Camber F ${s.alignment.frontCamber}° R ${s.alignment.rearCamber}°, Toe F ${s.alignment.frontToe}° R ${s.alignment.rearToe}°${caster}`);

  lines.push(`Anti-Roll Bars: F ${s.antiRollBars.front}, R ${s.antiRollBars.rear}`);

  const springUnit = s.springs.unit ?? "lb/in";
  lines.push(`Springs: F ${s.springs.frontRate} ${springUnit} @ ${s.springs.frontHeight}in, R ${s.springs.rearRate} ${springUnit} @ ${s.springs.rearHeight}in`);

  lines.push(`Damping: Rebound F ${s.damping.frontRebound} R ${s.damping.rearRebound}, Bump F ${s.damping.frontBump} R ${s.damping.rearBump}`);

  const aeroUnit = s.aero.unit ?? "lb";
  lines.push(`Aero: Front ${s.aero.frontDownforce} ${aeroUnit}, Rear ${s.aero.rearDownforce} ${aeroUnit}`);

  const diff = s.differential;
  let diffStr = `Accel ${diff.rearAccel}%, Decel ${diff.rearDecel}%`;
  if (diff.frontAccel != null) diffStr = `Front Accel ${diff.frontAccel}% Decel ${diff.frontDecel ?? 0}%, Rear ${diffStr}`;
  if (diff.center != null) diffStr += `, Center ${diff.center}%`;
  lines.push(`Differential: ${diffStr}`);

  lines.push(`Brakes: Balance ${s.brakes.balance}%, Pressure ${s.brakes.pressure}%`);

  return lines.join("\n");
}
