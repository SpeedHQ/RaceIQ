import type { TuneSettings } from "../../data/tune-catalog";

export function TuneSettingsPanel({ settings }: { settings: TuneSettings }) {
  const sections: { title: string; rows: [string, string][] }[] = [
    {
      title: "Tires",
      rows: [
        ["Front Pressure", `${settings.tires.frontPressure.toFixed(2)} bar`],
        ["Rear Pressure", `${settings.tires.rearPressure.toFixed(2)} bar`],
      ],
    },
    {
      title: "Gearing",
      rows: [
        ["Final Drive", settings.gearing.finalDrive.toFixed(2)],
        ...(settings.gearing.description
          ? [["Notes", settings.gearing.description] as [string, string]]
          : []),
      ],
    },
    {
      title: "Alignment",
      rows: [
        ["Front Camber", `${settings.alignment.frontCamber.toFixed(1)}\u00B0`],
        ["Rear Camber", `${settings.alignment.rearCamber.toFixed(1)}\u00B0`],
        ["Front Toe", `${settings.alignment.frontToe.toFixed(1)}\u00B0`],
        ["Rear Toe", `${settings.alignment.rearToe.toFixed(1)}\u00B0`],
        ...(settings.alignment.frontCaster != null
          ? [
              [
                "Front Caster",
                `${settings.alignment.frontCaster.toFixed(1)}\u00B0`,
              ] as [string, string],
            ]
          : []),
      ],
    },
    {
      title: "Anti-Roll Bars",
      rows: [
        ["Front", settings.antiRollBars.front.toFixed(1)],
        ["Rear", settings.antiRollBars.rear.toFixed(1)],
      ],
    },
    {
      title: "Springs",
      rows: [
        [
          "Front Rate",
          `${settings.springs.frontRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`,
        ],
        [
          "Rear Rate",
          `${settings.springs.rearRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`,
        ],
        ["Front Height", `${settings.springs.frontHeight.toFixed(1)} cm`],
        ["Rear Height", `${settings.springs.rearHeight.toFixed(1)} cm`],
      ],
    },
    {
      title: "Damping",
      rows: [
        ["Front Rebound", settings.damping.frontRebound.toFixed(1)],
        ["Rear Rebound", settings.damping.rearRebound.toFixed(1)],
        ["Front Bump", settings.damping.frontBump.toFixed(1)],
        ["Rear Bump", settings.damping.rearBump.toFixed(1)],
      ],
    },
    {
      title: "Aero",
      rows: [
        [
          "Front Downforce",
          `${settings.aero.frontDownforce} ${settings.aero.unit ?? "kgf"}`,
        ],
        [
          "Rear Downforce",
          `${settings.aero.rearDownforce} ${settings.aero.unit ?? "kgf"}`,
        ],
      ],
    },
    {
      title: "Differential",
      rows: [
        ["Rear Accel", `${settings.differential.rearAccel}%`],
        ["Rear Decel", `${settings.differential.rearDecel}%`],
        ...(settings.differential.frontAccel != null
          ? [
              [
                "Front Accel",
                `${settings.differential.frontAccel}%`,
              ] as [string, string],
            ]
          : []),
        ...(settings.differential.frontDecel != null
          ? [
              [
                "Front Decel",
                `${settings.differential.frontDecel}%`,
              ] as [string, string],
            ]
          : []),
      ],
    },
    {
      title: "Brakes",
      rows: [
        ["Balance", `${settings.brakes.balance}%`],
        ["Pressure", `${settings.brakes.pressure}%`],
      ],
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-2xl">
      {sections.map((section) => (
        <div key={section.title} className="rounded-lg bg-app-bg/85 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
            {section.title}
          </h4>
          <div className="space-y-0">
            {section.rows.map(([label, value]) => (
              <div key={label} className="flex justify-between text-xs gap-2">
                <span className="text-app-text-muted whitespace-nowrap">
                  {label}
                </span>
                <span
                  className="text-app-text font-mono whitespace-nowrap"
                  style={
                    label === "Notes"
                      ? { whiteSpace: "normal", textAlign: "right" }
                      : undefined
                  }
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
