// Shared F1 2025 setup field grouping — used by track-detail setup and range
// views plus top-level Setups browser so grouped expanded view stays identical.

export const SETUP_GROUPS: { title: string; fields: [string, string, string?][] }[] = [
  {
    title: "Aero",
    fields: [
      ["frontWing", "Front Wing"],
      ["rearWing", "Rear Wing"],
    ],
  },
  {
    title: "Transmission",
    fields: [
      ["diffOnThrottle", "On Throttle", "%"],
      ["diffOffThrottle", "Off Throttle", "%"],
    ],
  },
  {
    title: "Geometry",
    fields: [
      ["frontCamber", "F Camber", "°"],
      ["rearCamber", "R Camber", "°"],
      ["frontToe", "F Toe", "°"],
      ["rearToe", "R Toe", "°"],
    ],
  },
  {
    title: "Suspension",
    fields: [
      ["frontSuspension", "F Susp"],
      ["rearSuspension", "R Susp"],
      ["frontAntiRollBar", "F ARB"],
      ["rearAntiRollBar", "R ARB"],
      ["frontRideHeight", "F Height"],
      ["rearRideHeight", "R Height"],
    ],
  },
  {
    title: "Brakes",
    fields: [
      ["brakePressure", "Pressure"],
      ["frontBrakeBias", "Bias"],
    ],
  },
  {
    title: "Tires",
    fields: [
      ["frontLeftTyrePressure", "FL", " psi"],
      ["frontRightTyrePressure", "FR", " psi"],
      ["rearLeftTyrePressure", "RL", " psi"],
      ["rearRightTyrePressure", "RR", " psi"],
    ],
  },
];

/** Grouped F1 setup values, matching the track-detail setups layout. */
export function F125SetupValues({ setup }: { setup: Record<string, number | null> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-6 content-start">
      {SETUP_GROUPS.map((group) => (
        <div key={group.title}>
          <div className="text-xs text-app-accent uppercase tracking-wider font-bold mt-2 mb-1 border-b border-app-border/20 pb-0.5">{group.title}</div>
          {group.fields.map(([key, label, unit]) => {
            const val = setup[key];
            return (
              <div key={key} className="flex justify-between py-0.5">
                <span className="text-app-label font-semibold text-app-text">{label}</span>
                <span className="text-app-label font-mono font-medium text-app-text">{val != null ? `${val}${unit ?? ""}` : "—"}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
