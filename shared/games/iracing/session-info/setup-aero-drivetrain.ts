import type { IRacingSessionInfoCatalogField } from "./contracts";
import { humanize } from "./formatting";
import { setupField } from "./setup-builders";

export const IRACING_AERO_DRIVETRAIN_SETUP_FIELDS: readonly IRacingSessionInfoCatalogField[] = [
  setupField(
    "TiresAero.AeroBalanceCalc.FrontRhAtSpeed",
    "Front ride height at speed",
    "value-with-unit",
    "Calculated front ride height at reference speed.",
    "setup.aero.front-ride-height-at-speed",
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.RearRhAtSpeed",
    "Rear ride height at speed",
    "value-with-unit",
    "Calculated rear ride height at reference speed.",
    "setup.aero.rear-ride-height-at-speed",
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.RearWingAngle",
    "Rear wing angle",
    "value-with-unit",
    "Rear wing angle used by iRacing aero calculator.",
    "setup.aero.rear-wing.angle",
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.WingSetting",
    "Wing setting",
    "configuration",
    "Wing setting used by iRacing aero calculator.",
    "setup.aero.rear-wing.setting",
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.FrontDownforce",
    "Front downforce",
    "value-with-unit",
    "Calculated front downforce or aero balance.",
    "setup.aero.front-downforce",
  ),
  setupField(
    "Drivetrain.Differential.ClutchPlates",
    "Differential clutch plates",
    "count",
    "Number of differential clutch plates.",
    "setup.drivetrain.differential-clutch-plates",
  ),
  setupField(
    "Drivetrain.Differential.FrictionFaces",
    "Differential friction faces",
    "count",
    "Number of differential friction faces.",
    "setup.drivetrain.differential-clutch-plates",
  ),
  setupField(
    "Drivetrain.Differential.Preload",
    "Differential preload",
    "value-with-unit",
    "Mechanical differential preload.",
    "setup.drivetrain.differential-preload",
  ),
  setupField(
    "Drivetrain.Differential.DriveRampAngle",
    "Differential drive ramp",
    "value-with-unit",
    "Power-side differential ramp angle.",
    "setup.drivetrain.differential-drive-ramp",
  ),
  setupField(
    "Drivetrain.Differential.CoastRampAngle",
    "Differential coast ramp",
    "value-with-unit",
    "Coast-side differential ramp angle.",
    "setup.drivetrain.differential-coast-ramp",
  ),
  setupField(
    "Drivetrain.Transmission.FinalDrive",
    "Final drive",
    "ratio",
    "Transmission final-drive ratio or selection.",
    "setup.drivetrain.final-drive",
  ),
  ...[
    "FirstGear",
    "SecondGear",
    "ThirdGear",
    "FourthGear",
    "FifthGear",
    "SixthGear",
    "SeventhGear",
    "EighthGear",
  ].map((field) =>
    setupField(
      `Drivetrain.Transmission.${field}`,
      humanize(field),
      "ratio",
      `${humanize(field)} ratio or selection.`,
      "setup.drivetrain.gear-ratios",
    ),
  ),
];
