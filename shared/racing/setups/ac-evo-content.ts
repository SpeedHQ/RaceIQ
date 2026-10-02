import type { SetupContentRow, SetupContentSection } from "./content";

interface KnobDescriptor {
  title: string;
  label: string;
  knob: string;
  scale?: number;
  unit?: string;
  step?: number;
}

/** Verified flat-knob to source-summary mapping. Scale converts canonical values to displayed values. */
const KNOBS: readonly KnobDescriptor[] = [
  { title: "Front", label: "Brake bias", knob: "brakeBias", unit: "% front", step: 0.1 },
  { title: "Front", label: "Steer ratio", knob: "steerRatio", step: 1 },
  { title: "Front", label: "Anti-roll bar", knob: "frontARB", unit: " clicks", step: 1 },
  { title: "Rear", label: "Anti-roll bar", knob: "rearARB", unit: " clicks", step: 1 },
  { title: "Rear", label: "Differential preload", knob: "diffPreload", unit: " Nm" },
  { title: "Front left", label: "Tyre pressure", knob: "frontLeftTyrePressure", unit: " psi", step: 0.1 },
  { title: "Front right", label: "Tyre pressure", knob: "frontRightTyrePressure", unit: " psi", step: 0.1 },
  { title: "Rear left", label: "Tyre pressure", knob: "rearLeftTyrePressure", unit: " psi", step: 0.1 },
  { title: "Rear right", label: "Tyre pressure", knob: "rearRightTyrePressure", unit: " psi", step: 0.1 },
  { title: "Front left", label: "Toe", knob: "frontToe", step: 0.01 },
  { title: "Rear left", label: "Toe", knob: "rearToe", step: 0.01 },
  { title: "Front left", label: "Camber", knob: "frontCamber", unit: "°", step: 0.1 },
  { title: "Rear left", label: "Camber", knob: "rearCamber", unit: "°", step: 0.1 },
  { title: "Front left", label: "Wheel rate", knob: "frontSpringRate", scale: 0.001, unit: " kN/m" },
  { title: "Rear left", label: "Wheel rate", knob: "rearSpringRate", scale: 0.001, unit: " kN/m" },
  { title: "Front left", label: "Slow bump", knob: "frontBump", step: 1 },
  { title: "Rear left", label: "Slow bump", knob: "rearBump", step: 1 },
  { title: "Front left", label: "Slow rebound", knob: "frontRebound", step: 1 },
  { title: "Rear left", label: "Slow rebound", knob: "rearRebound", step: 1 },
  { title: "Electronics", label: "TC", knob: "tc", step: 1 },
  { title: "Electronics", label: "TC2", knob: "tc2", step: 1 },
  { title: "Electronics", label: "ABS", knob: "abs", step: 1 },
  { title: "Electronics", label: "Engine map", knob: "engineMap", step: 1 },
  { title: "Aero & ride height", label: "Front ride height", knob: "frontRideHeight", unit: " mm", step: 1 },
  { title: "Aero & ride height", label: "Rear ride height", knob: "rearRideHeight", unit: " mm", step: 1 },
  { title: "Aero & ride height", label: "Front wing", knob: "frontWing", step: 1 },
  { title: "Aero & ride height", label: "Rear wing", knob: "rearWing", step: 1 },
  { title: "Fuel & strategy", label: "Fuel load", knob: "fuel", unit: " L", step: 1 },
];

const descriptorByRow: Record<string, KnobDescriptor> = Object.fromEntries(
  KNOBS.map((descriptor) => [`${descriptor.title}\0${descriptor.label}`, descriptor]),
);
const format = (value: number): string => Number.isInteger(value) ? String(value) : String(+value.toFixed(4));

/** Annotate authoritative decoded summary rows; unmatched/fixed/source-only rows stay read-only. */
export function annotateAcEvoSections(
  sections: readonly SetupContentSection[],
  knobs: Record<string, number>,
  ranges?: Record<string, { min: number; max: number; step: number } | null> | null,
): SetupContentSection[] {
  return sections.map((section) => ({
    ...section,
    rows: section.rows.map((row) => {
      if (row.fixed) return row;
      const descriptor = descriptorByRow[`${section.title}\0${row.label}`];
      if (!descriptor || !Number.isFinite(knobs[descriptor.knob])) return row;
      if (ranges && Object.hasOwn(ranges, descriptor.knob) && ranges[descriptor.knob] === null) {
        return { ...row, fixed: true };
      }
      const scale = descriptor.scale ?? 1;
      const displayNum = row.num != null ? row.num * scale : Number.parseFloat(row.value);
      return {
        ...row,
        knob: descriptor.knob,
        scale,
        ...(descriptor.unit ? { unit: descriptor.unit } : {}),
        ...(descriptor.step == null ? {} : { step: descriptor.step }),
        ...(displayNum == null ? {} : { num: displayNum }),
        ...(row.min == null ? {} : { min: row.min * scale }),
        ...(row.max == null ? {} : { max: row.max * scale }),
      };
    }),
  }));
}
/** Render known editable rows from flat/manual tune values without inventing missing numbers. */
export function summarizeAcEvoKnobs(settings: Record<string, unknown>): SetupContentSection[] {
  const sections: SetupContentSection[] = [];
  for (const descriptor of KNOBS) {
    const raw = settings[descriptor.knob];
    let section = sections.find((candidate) => candidate.title === descriptor.title);
    if (!section) {
      section = { title: descriptor.title, rows: [] };
      sections.push(section);
    }
    const displayed = typeof raw === "number" && Number.isFinite(raw) ? raw * (descriptor.scale ?? 1) : undefined;
    const unit = descriptor.unit ?? "";
    const value = displayed == null ? "" : `${format(displayed)}${unit}`;
    const row: SetupContentRow = {
      label: descriptor.label,
      value,
      ...(displayed == null ? {} : { num: displayed }),
      knob: descriptor.knob,
      scale: descriptor.scale ?? 1,
      ...(descriptor.unit ? { unit: descriptor.unit } : {}),
      ...(descriptor.step == null ? {} : { step: descriptor.step }),
    };
    section.rows.push(row);
  }
  const fixedRows: SetupContentRow[] = [];
  for (const [knob, label] of [["diffPower", "Diff power"], ["diffCoast", "Diff coast"]] as const) {
    const value = settings[knob];
    if (typeof value === "number" && Number.isFinite(value)) fixedRows.push({ label, value: format(value), num: value, fixed: true });
  }
  if (fixedRows.length) sections.push({ title: "Mechanical & brakes", rows: fixedRows });
  return sections;
}
