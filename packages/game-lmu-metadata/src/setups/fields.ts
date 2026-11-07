/*
 * Adapted from setup-ripple by JojoJing (c) 2026, pinned commit
 * 6239277da04a1f09027591aaa00fd047780b6efa.
 * Upstream: https://github.com/jojojing-dev/setup-ripple
 * MIT License
 * Copyright (c) 2026 JojoJing
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type SvmFieldTuple = readonly [section: string, key: string, label: string];

export interface SvmFieldGroup {
  readonly title: string;
  readonly lr?: boolean;
  readonly third?: boolean;
  readonly fields: readonly SvmFieldTuple[];
}

export interface SvmSetupPage {
  readonly id: string;
  readonly name: string;
  readonly groups: readonly SvmFieldGroup[];
}

export const LMU_SETUP_PAGES: readonly SvmSetupPage[] = [
  { id: "basic", name: "Basic", groups: [
    { title: "Virtual Energy", fields: [["GENERAL", "VirtualEnergySetting", "Virtual Energy"], ["GENERAL", "FuelSetting", "Fuel Ratio"], ["GENERAL", "FuelCapacitySetting", "Fuel Carried"]] },
    { title: "Electronics", fields: [["CONTROLS", "RearBrakeSetting", "Brake bias"], ["CONTROLS", "AntilockBrakeSystemMapSetting", "ABS"], ["CONTROLS", "TractionControlMapSetting", "Onboard TC"], ["CONTROLS", "TCPowerCutMapSetting", "TC Power Cut"], ["CONTROLS", "TCSlipAngleMapSetting", "TC Slip Angle"]] },
    { title: "Aero", fields: [["REARWING", "RWSetting", "Rear wing"]] },
  ] },
  { id: "powertrain", name: "Powertrain", groups: [
    { title: "Engine", fields: [["GENERAL", "VirtualEnergySetting", "Virtual Energy"], ["GENERAL", "FuelSetting", "Fuel Ratio"], ["ENGINE", "RevLimitSetting", "Rev Limiter"], ["ENGINE", "EngineMixtureSetting", "Engine Mixture"], ["BODYAERO", "WaterRadiatorSetting", "Water radiator cover"], ["BODYAERO", "OilRadiatorSetting", "Oil radiator cover"]] },
    { title: "Electronics", fields: [["CONTROLS", "TractionControlMapSetting", "Onboard TC"], ["CONTROLS", "TCPowerCutMapSetting", "TC Power Cut"], ["CONTROLS", "TCSlipAngleMapSetting", "TC Slip Angle"], ["ENGINE", "RegenerationMapSetting", "Regen level"], ["ENGINE", "ElectricMotorMapSetting", "Electric motor map"]] },
    { title: "Differential", fields: [["DRIVELINE", "DiffPowerSetting", "Power"], ["DRIVELINE", "DiffCoastSetting", "Coast"], ["DRIVELINE", "DiffPreloadSetting", "Preload"], ["DRIVELINE", "FrontDiffPowerSetting", "Front Power"], ["DRIVELINE", "FrontDiffCoastSetting", "Front Coast"], ["DRIVELINE", "FrontDiffPreloadSetting", "Front Preload"]] },
    { title: "Gearing", fields: [["DRIVELINE", "RatioSetSetting", "Ratio Set"]] },
  ] },
  { id: "wheels", name: "Wheels & Brakes", groups: [
    { title: "Front Wheels", lr: true, fields: [["FRONTLEFT", "CompoundSetting", "Compound"], ["FRONTLEFT", "PressureSetting", "Tyre pressure"], ["FRONTLEFT", "CamberSetting", "Camber"]] },
    { title: "Rear Wheels", lr: true, fields: [["REARLEFT", "CompoundSetting", "Compound"], ["REARLEFT", "PressureSetting", "Tyre pressure"], ["REARLEFT", "CamberSetting", "Camber"]] },
    { title: "Brakes", fields: [["CONTROLS", "RearBrakeSetting", "Brake bias"], ["CONTROLS", "BrakeMigrationSetting", "Brake Migration"], ["CONTROLS", "BrakePressureSetting", "Max pedal force"], ["BODYAERO", "BrakeDuctSetting", "Front brake duct blanking"], ["BODYAERO", "BrakeDuctRearSetting", "Rear brake duct blanking"]] },
  ] },
  { id: "suspension", name: "Suspension", groups: [
    { title: "Front Suspension", lr: true, third: true, fields: [["FRONTLEFT", "SpringSetting", "Spring rate"], ["FRONTLEFT", "PackerSetting", "Packers"], ["FRONTLEFT", "RideHeightSetting", "Ride height"]] },
    { title: "Rear Suspension", lr: true, third: true, fields: [["REARLEFT", "SpringSetting", "Spring rate"], ["REARLEFT", "PackerSetting", "Packers"], ["REARLEFT", "RideHeightSetting", "Ride height"]] },
  ] },
  { id: "dampers", name: "Dampers", groups: [
    { title: "Front Suspension", lr: true, third: true, fields: [["FRONTLEFT", "SlowBumpSetting", "Slow bump"], ["FRONTLEFT", "SlowReboundSetting", "Slow rebound"], ["FRONTLEFT", "FastBumpSetting", "Fast bump"], ["FRONTLEFT", "FastReboundSetting", "Fast rebound"]] },
    { title: "Rear Suspension", lr: true, third: true, fields: [["REARLEFT", "SlowBumpSetting", "Slow bump"], ["REARLEFT", "SlowReboundSetting", "Slow rebound"], ["REARLEFT", "FastBumpSetting", "Fast bump"], ["REARLEFT", "FastReboundSetting", "Fast rebound"]] },
  ] },
  { id: "chassis", name: "Chassis & Aero", groups: [
    { title: "Front Chassis", fields: [["SUSPENSION", "FrontToeInSetting", "Toe-in"], ["SUSPENSION", "FrontAntiSwaySetting", "Anti-roll bar"], ["CONTROLS", "SteerLockSetting", "Wheel Range (Lock)"], ["FRONTWING", "FWSetting", "Front wing"]] },
    { title: "Rear Chassis", fields: [["SUSPENSION", "RearToeInSetting", "Toe-in"], ["SUSPENSION", "RearAntiSwaySetting", "Anti-roll bar"], ["REARWING", "RWSetting", "Rear wing"]] },
  ] },
] as const;

const THIRD_KEYS: Readonly<Record<string, string>> = {
  SpringSetting: "3rdSpringSetting", PackerSetting: "3rdPackerSetting",
  SlowBumpSetting: "3rdSlowBumpSetting", SlowReboundSetting: "3rdSlowReboundSetting",
  FastBumpSetting: "3rdFastBumpSetting", FastReboundSetting: "3rdFastReboundSetting",
};

export function thirdKeyFor(section: string, key: string): readonly [string, string] | null {
  const side = section.startsWith("FRONT") ? "Front" : section.startsWith("REAR") ? "Rear" : null;
  const thirdKey = THIRD_KEYS[key];
  return side && thirdKey ? ["SUSPENSION", side + thirdKey] : null;
}

export interface SvmFieldDescriptor {
  readonly pageId: string;
  readonly pageName: string;
  readonly group: string;
  readonly label: string;
  readonly section: string;
  readonly key: string;
  readonly axle?: "left" | "right" | "third";
}

const descriptors = new Map<string, SvmFieldDescriptor>();
for (const page of LMU_SETUP_PAGES) {
  for (const group of page.groups) {
    for (const [leftSection, key, label] of group.fields) {
      const axleSections: readonly (readonly [string, SvmFieldDescriptor["axle"]])[] = group.lr
        ? [[leftSection, "left" as const], [leftSection.replace(/LEFT$/, "RIGHT"), "right" as const]]
        : [[leftSection, undefined]];
      for (const [section, axle] of axleSections) {
        const id = `${section}.${key}`;
        descriptors.set(id, { pageId: page.id, pageName: page.name, group: group.title, label, section, key, ...(axle ? { axle } : {}) });
      }
      if (group.third) {
        const third = thirdKeyFor(leftSection, key);
        if (third) {
          const [section, thirdSetting] = third;
          const thirdLabel = `${label} (3rd)`;
          descriptors.set(`${section}.${thirdSetting}`, { pageId: page.id, pageName: page.name, group: group.title, label: thirdLabel, section, key: thirdSetting, axle: "third" });
        }
      }
    }
  }
}

export function getSvmFieldDescriptor(id: string): SvmFieldDescriptor | null {
  return descriptors.get(id) ?? null;
}
