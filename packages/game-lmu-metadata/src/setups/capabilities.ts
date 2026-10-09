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
import type { SvmDocument } from "./svm";
import { getSvmFieldDescriptor } from "./fields";

export type SvmArchitecture = "lmdh" | "lmh-front-hybrid" | "lmh-non-hybrid" | "unknown";

export interface SvmCapabilities {
  readonly architecture: SvmArchitecture;
  readonly hybrid: boolean | null;
  readonly frontDrive: boolean | null;
  readonly abs: boolean | null;
}

const ARCHITECTURE_BY_ID: Readonly<Record<string, Exclude<SvmArchitecture, "unknown">>> = {
  alpine_a424_2024: "lmdh",
  bmw_m_hybrid_v8_2023: "lmdh",
  "cadillac_v-lmdh_2023": "lmdh",
  genesis_gmr001_2026: "lmdh",
  lamborghini_sc63_2024: "lmdh",
  porsche_963_2023: "lmdh",
  ferrari_499p_2023: "lmh-front-hybrid",
  isotta_tipo6_2024: "lmh-front-hybrid",
  peugeot_9x8_2023: "lmh-front-hybrid",
  peugeot_9x8_2024: "lmh-front-hybrid",
  toyota_gr10_2023: "lmh-front-hybrid",
  aston_martin_valkyrie_2025: "lmh-non-hybrid",
  sgc_007_2023: "lmh-non-hybrid",
  vandervell_680_2023: "lmh-non-hybrid",
};

const DISTINCTIVE_MODEL_ALIASES: readonly [RegExp, Exclude<SvmArchitecture, "unknown">][] = [
  [/\b963\b/i, "lmdh"],
  [/\bbmw\s*m\s*hybrid\b/i, "lmdh"],
  [/cadillac\s*v[- ]?series|v[- ]?lmdh/i, "lmdh"],
  [/genesis\s*gmr[- ]?001/i, "lmdh"],
  [/\bsc63\b/i, "lmdh"],
  [/\b499p\b/i, "lmh-front-hybrid"],
  [/\b(?:gr010|tr010)\b/i, "lmh-front-hybrid"],
  [/\b9x8\b/i, "lmh-front-hybrid"],
  [/\b(?:isotta\s*)?tipo\s*6\b/i, "lmh-front-hybrid"],
  [/valkyrie/i, "lmh-non-hybrid"],
  [/glickenhaus|scg\s*0?07/i, "lmh-non-hybrid"],
  [/vandervell|vanwall/i, "lmh-non-hybrid"],
  [/alpine\s*a[- ]?424/i, "lmdh"],
];

function inferArchitecture(document: SvmDocument): SvmArchitecture {
  if (document.className !== "Hypercar") return "unknown";
  if (document.carId !== null) return ARCHITECTURE_BY_ID[document.carId] ?? "unknown";
  for (const [pattern, architecture] of DISTINCTIVE_MODEL_ALIASES) {
    if (pattern.test(document.carName)) return architecture;
  }
  return "unknown";
}

export function getSvmCapabilities(document: SvmDocument): SvmCapabilities {
  const architecture = inferArchitecture(document);
  const nonHybridClass = ["LMP2", "LMP3", "GTE", "GT3"].includes(document.className ?? "");
  const hybrid = nonHybridClass ? false : architecture === "unknown" ? null : architecture !== "lmh-non-hybrid";
  const frontDrive = nonHybridClass ? false : architecture === "unknown" ? null : architecture === "lmh-front-hybrid";
  let abs: boolean | null = null;
  if (["LMP2", "LMP3", "GTE", "Hypercar"].includes(document.className ?? "")) abs = false;
  else if (document.className === "GT3") abs = true;
  return { architecture, hybrid, frontDrive, abs };
}

export interface SvmFieldAccess {
  readonly editable: boolean;
  readonly reason: string | null;
}

const UNAVAILABLE_LABEL = /non-adjustable|fixed|n\/a|standard/i;
const DETACHED = /^detached$/i;
const ARB_KEYS = new Set(["SUSPENSION.FrontAntiSwaySetting", "SUSPENSION.RearAntiSwaySetting"]);
const FRONT_DIFF = new Set([
  "DRIVELINE.FrontDiffPowerSetting",
  "DRIVELINE.FrontDiffCoastSetting",
  "DRIVELINE.FrontDiffPreloadSetting",
]);
const HYBRID_CONTROLS = new Set(["ENGINE.RegenerationMapSetting", "ENGINE.ElectricMotorMapSetting"]);

export function getSvmFieldAccess(document: SvmDocument, id: string): SvmFieldAccess {
  const descriptor = getSvmFieldDescriptor(id);
  const setting = document.settings.get(id);
  if (!descriptor || !setting) return { editable: false, reason: "Field is not a mapped setting" };
  if (id === "GENERAL.FuelCapacitySetting") return { editable: false, reason: "Fuel carried is derived" };
  if (!setting.display.trim()) return { editable: false, reason: "Field has no display label" };
  const label = setting.display.trim();
  if (UNAVAILABLE_LABEL.test(label) || (DETACHED.test(label) && !ARB_KEYS.has(id))) {
    return { editable: false, reason: "Field is fixed or unavailable" };
  }
  const capabilities = getSvmCapabilities(document);
  if (FRONT_DIFF.has(id)) {
    if (capabilities.frontDrive === null) return { editable: false, reason: "Front-drive capability is unknown" };
    if (!capabilities.frontDrive) return { editable: false, reason: "Field requires front-wheel drive" };
  }
  if (HYBRID_CONTROLS.has(id)) {
    if (capabilities.hybrid === null) return { editable: false, reason: "Hybrid capability is unknown" };
    if (!capabilities.hybrid) return { editable: false, reason: "Field requires hybrid capability" };
  }
  return { editable: true, reason: null };
}
