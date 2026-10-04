import { useState } from "react";
import type { ReactNode } from "react";
import { getSvmFieldDescriptor, LMU_SETUP_PAGES, thirdKeyFor } from "@raceiq/game-lmu-metadata/setups/fields";
import type { SvmDocument } from "@raceiq/game-lmu-metadata/setups/svm";
import { getSvmCapabilities, getSvmFieldAccess } from "@raceiq/game-lmu-metadata/setups/capabilities";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface LmuSetupPagesProps { document: SvmDocument; pending: ReadonlyMap<string, number>; onStep: (ids: readonly string[], direction: 1 | -1) => void }

const FIELD_LABELS: Record<string, () => string> = {
  "GENERAL.VirtualEnergySetting": m.lmu_setup_field_general_virtual_energy, "GENERAL.FuelSetting": m.lmu_setup_field_general_fuel, "GENERAL.FuelCapacitySetting": m.lmu_setup_field_general_fuel_capacity,
  "CONTROLS.RearBrakeSetting": m.lmu_setup_field_controls_rear_brake, "CONTROLS.AntilockBrakeSystemMapSetting": m.lmu_setup_field_controls_abs, "CONTROLS.TractionControlMapSetting": m.lmu_setup_field_controls_traction_control, "CONTROLS.TCPowerCutMapSetting": m.lmu_setup_field_controls_tc_power_cut, "CONTROLS.TCSlipAngleMapSetting": m.lmu_setup_field_controls_tc_slip_angle, "CONTROLS.BrakeMigrationSetting": m.lmu_setup_field_brake_migration, "CONTROLS.BrakePressureSetting": m.lmu_setup_field_brake_pressure, "CONTROLS.SteerLockSetting": m.lmu_setup_field_steer_lock,
  "REARWING.RWSetting": m.lmu_setup_field_rearwing, "ENGINE.RevLimitSetting": m.lmu_setup_field_engine_rev_limit, "ENGINE.EngineMixtureSetting": m.lmu_setup_field_engine_mixture, "ENGINE.RegenerationMapSetting": m.lmu_setup_field_regeneration, "ENGINE.ElectricMotorMapSetting": m.lmu_setup_field_electric_motor,
  "BODYAERO.WaterRadiatorSetting": m.lmu_setup_field_water_radiator, "BODYAERO.OilRadiatorSetting": m.lmu_setup_field_oil_radiator, "BODYAERO.BrakeDuctSetting": m.lmu_setup_field_front_brake_duct, "BODYAERO.BrakeDuctRearSetting": m.lmu_setup_field_rear_brake_duct,
  "DRIVELINE.DiffPowerSetting": m.lmu_setup_field_diff_power, "DRIVELINE.DiffCoastSetting": m.lmu_setup_field_diff_coast, "DRIVELINE.DiffPreloadSetting": m.lmu_setup_field_diff_preload, "DRIVELINE.FrontDiffPowerSetting": m.lmu_setup_field_front_diff_power, "DRIVELINE.FrontDiffCoastSetting": m.lmu_setup_field_front_diff_coast, "DRIVELINE.FrontDiffPreloadSetting": m.lmu_setup_field_front_diff_preload, "DRIVELINE.RatioSetSetting": m.lmu_setup_field_ratio_set,
  "FRONTLEFT.CompoundSetting": m.lmu_setup_field_compound, "REARLEFT.CompoundSetting": m.lmu_setup_field_compound, "FRONTLEFT.PressureSetting": m.lmu_setup_field_pressure, "REARLEFT.PressureSetting": m.lmu_setup_field_pressure, "FRONTLEFT.CamberSetting": m.lmu_setup_field_camber, "REARLEFT.CamberSetting": m.lmu_setup_field_camber,
  "FRONTLEFT.SpringSetting": m.lmu_setup_field_spring, "REARLEFT.SpringSetting": m.lmu_setup_field_spring, "FRONTLEFT.PackerSetting": m.lmu_setup_field_packer, "REARLEFT.PackerSetting": m.lmu_setup_field_packer, "FRONTLEFT.RideHeightSetting": m.lmu_setup_field_ride_height, "REARLEFT.RideHeightSetting": m.lmu_setup_field_ride_height,
  "FRONTLEFT.SlowBumpSetting": m.lmu_setup_field_slow_bump, "REARLEFT.SlowBumpSetting": m.lmu_setup_field_slow_bump, "FRONTLEFT.SlowReboundSetting": m.lmu_setup_field_slow_rebound, "REARLEFT.SlowReboundSetting": m.lmu_setup_field_slow_rebound, "FRONTLEFT.FastBumpSetting": m.lmu_setup_field_fast_bump, "REARLEFT.FastBumpSetting": m.lmu_setup_field_fast_bump, "FRONTLEFT.FastReboundSetting": m.lmu_setup_field_fast_rebound, "REARLEFT.FastReboundSetting": m.lmu_setup_field_fast_rebound,
  "SUSPENSION.FrontToeInSetting": m.lmu_setup_field_front_toe, "SUSPENSION.FrontAntiSwaySetting": m.lmu_setup_field_front_arb, "SUSPENSION.RearToeInSetting": m.lmu_setup_field_rear_toe, "SUSPENSION.RearAntiSwaySetting": m.lmu_setup_field_rear_arb, "FRONTWING.FWSetting": m.lmu_setup_field_front_wing,
};
const PAGE_LABELS: Record<string, () => string> = { basic: m.lmu_setup_page_basic, powertrain: m.lmu_setup_page_powertrain, wheels: m.lmu_setup_page_wheels, suspension: m.lmu_setup_page_suspension, dampers: m.lmu_setup_page_dampers, chassis: m.lmu_setup_page_chassis };
const GROUP_LABELS: Record<string, () => string> = {
  "basic:Virtual Energy": m.lmu_setup_group_basic_virtual_energy, "basic:Electronics": m.lmu_setup_group_basic_electronics, "basic:Aero": m.lmu_setup_group_basic_aero,
  "powertrain:Engine": m.lmu_setup_group_powertrain_engine, "powertrain:Electronics": m.lmu_setup_group_powertrain_electronics, "powertrain:Differential": m.lmu_setup_group_powertrain_differential, "powertrain:Gearing": m.lmu_setup_group_powertrain_gearing,
  "wheels:Front Wheels": m.lmu_setup_group_wheels_front_wheels, "wheels:Rear Wheels": m.lmu_setup_group_wheels_rear_wheels, "wheels:Brakes": m.lmu_setup_group_wheels_brakes,
  "suspension:Front Suspension": m.lmu_setup_group_suspension_front_suspension, "suspension:Rear Suspension": m.lmu_setup_group_suspension_rear_suspension, "dampers:Front Suspension": m.lmu_setup_group_dampers_front_suspension, "dampers:Rear Suspension": m.lmu_setup_group_dampers_rear_suspension,
  "chassis:Front Chassis": m.lmu_setup_group_chassis_front_chassis, "chassis:Rear Chassis": m.lmu_setup_group_chassis_rear_chassis,
};

function lockedReason(reason: string | null): string {
  const labels: Record<string, () => string> = {
    "Field is not a mapped setting": m.lmu_setup_reason_unmapped, "Fuel carried is derived": m.lmu_setup_reason_derived, "Field has no display label": m.lmu_setup_reason_no_label, "Field is fixed or unavailable": m.lmu_setup_reason_fixed,
    "Front-drive capability is unknown": m.lmu_setup_reason_frontdrive_unknown, "Field requires front-wheel drive": m.lmu_setup_reason_frontdrive_required, "Hybrid capability is unknown": m.lmu_setup_reason_hybrid_unknown, "Field requires hybrid capability": m.lmu_setup_reason_hybrid_required,
  };
  return reason ? labels[reason]?.() ?? reason : "";
}

function SettingRow({ document, pending, ids, label, linked, onStep, onLink }: { document: SvmDocument; pending: ReadonlyMap<string, number>; ids: readonly string[]; label: string; linked?: boolean; onStep: LmuSetupPagesProps["onStep"]; onLink?: () => void }) {
  const settings = ids.map((id) => document.settings.get(id) ?? null);
  if (settings.every((setting) => !setting)) return null;
  const access = ids.map((id) => getSvmFieldAccess(document, id));
  const editable = settings.map((setting, index) => Boolean(setting && access[index]?.editable));
  const canLink = Boolean(onLink && settings.length === 2 && settings.every(Boolean) && editable.every(Boolean));
  const fieldId = ids.find((id) => document.settings.has(id))!;
  const fieldKey = fieldId.replace(/RIGHT\./, "LEFT.").replace(/^SUSPENSION\.Front3rd/, "FRONTLEFT.").replace(/^SUSPENSION\.Rear3rd/, "REARLEFT.");
  const isThird = getSvmFieldDescriptor(fieldId)?.axle === "third";
  const baseLabel = FIELD_LABELS[fieldKey]?.() ?? label;
  const displayLabel = isThird ? `${baseLabel} (${m.lmu_setup_field_third()})` : baseLabel;
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border py-3 last:border-0">
    <div className="min-w-40 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-app-text">{displayLabel}</span>
        {settings.map((setting, index) => setting && <Badge key={ids[index]} variant="neutral" size="compact">
          {setting.section.endsWith("LEFT") ? m.lmu_setup_field_left() : setting.section.endsWith("RIGHT") ? m.lmu_setup_field_right() : isThird ? m.lmu_setup_field_third() : setting.section}: {setting.display || m.lmu_setup_no_display()} · {m.lmu_setup_index()} {setting.index}
          {(pending.get(ids[index]!) ?? 0) !== 0 && <> {(pending.get(ids[index]!)! > 0 ? "+" : "") + pending.get(ids[index]!)} {m.lmu_setup_clicks()}</>}
        </Badge>)}
      </div>
      {settings.some((setting, index) => setting && !editable[index]) && <div className="mt-1 text-app-caption text-app-text-muted">{settings.map((setting, index) => setting && !editable[index] ? lockedReason(access[index]?.reason ?? null) : null).filter(Boolean).join("; ")}</div>}
    </div>
    {canLink && <Button size="xs" variant={linked ? "selected-toggle" : "outline"} aria-pressed={linked} onClick={onLink}>{linked ? m.lmu_setup_unlink_corners() : m.lmu_setup_link_corners()}</Button>}
    {settings.some((setting, index) => setting && editable[index]) && <div className="flex items-center gap-1">
      {settings.map((setting, index) => setting && editable[index] && <div key={ids[index]} className="flex items-center gap-1">
        <Button size="icon-xs" variant="outline" aria-label={`${m.lmu_setup_decrease()} ${displayLabel} ${setting.id}`} disabled={setting.index + (pending.get(ids[index]!) ?? 0) <= 0} onClick={() => onStep([ids[index]!], -1)}>−</Button>
        <Button size="icon-xs" variant="outline" aria-label={`${m.lmu_setup_increase()} ${displayLabel} ${setting.id}`} onClick={() => onStep([ids[index]!], 1)}>+</Button>
      </div>)}
    </div>}
  </div>;
}

export function LmuSetupPages({ document, pending, onStep }: LmuSetupPagesProps) {
  const [page, setPage] = useState(LMU_SETUP_PAGES[0]!.id);
  const [linked, setLinked] = useState<ReadonlySet<string>>(() => new Set());
  const capabilities = getSvmCapabilities(document);
  const unknown = [...document.settings.keys()].filter((id) => !getSvmFieldDescriptor(id));
  return <div className="flex flex-col gap-4"><div className="flex flex-wrap items-center gap-2"><Badge variant="catalog-category">{document.carName || m.lmu_setup_unknown_car()}</Badge><Badge>{document.className ?? m.lmu_setup_unknown_class()}</Badge><Badge>{capabilities.architecture}</Badge>{document.identityWarning && <Badge variant="warning">{document.identityWarning}</Badge>}</div><Tabs value={page} onValueChange={setPage}><TabsList>{LMU_SETUP_PAGES.map((item) => <TabsTrigger key={item.id} value={item.id}>{PAGE_LABELS[item.id]?.() ?? item.name}</TabsTrigger>)}</TabsList>{LMU_SETUP_PAGES.map((item) => { const cards: ReactNode[] = []; for (const group of item.groups) { const rows: ReactNode[] = []; for (const [section, key, label] of group.fields) { const ids = group.lr ? [`${section}.${key}`, `${section.replace(/LEFT$/, "RIGHT")}.${key}`] : [`${section}.${key}`]; const fields = ids.map((id) => document.settings.get(id)); const presentIds = ids.filter((id) => document.settings.has(id)); if (presentIds.length) { const linkKey = ids[0]!; const both = ids.length === 2 && fields.every(Boolean); const equalEditable = both && fields[0]!.index === fields[1]!.index && ids.every((id) => getSvmFieldAccess(document, id).editable); const isLinked = both && (linked.has(linkKey) || (equalEditable && !linked.has(`!${linkKey}`))); const toggleLink = () => setLinked((old) => { const next = new Set(old); if (isLinked) { next.delete(linkKey); next.add(`!${linkKey}`); } else { next.add(linkKey); next.delete(`!${linkKey}`); } return next; }); rows.push(<SettingRow key={linkKey} document={document} pending={pending} ids={presentIds} label={label} linked={isLinked} onLink={both && ids.every((id) => getSvmFieldAccess(document, id).editable) ? toggleLink : undefined} onStep={(targetIds, direction) => onStep(isLinked ? ids : targetIds, direction)} />); } if (group.third) { const third = thirdKeyFor(section, key); const id = third && `${third[0]}.${third[1]}`; if (id && document.settings.has(id)) rows.push(<SettingRow key={id} document={document} pending={pending} ids={[id]} label={`${label} (${m.lmu_setup_field_third()})`} onStep={onStep} />); } } if (rows.length) cards.push(<Card key={group.title} size="sm"><CardHeader><CardTitle>{GROUP_LABELS[`${item.id}:${group.title}`]?.() ?? group.title}</CardTitle></CardHeader><CardContent>{rows}</CardContent></Card>); } return <TabsContent key={item.id} value={item.id} className="mt-4 flex flex-col gap-3">{cards.length ? cards : <p className="rounded border border-app-border p-4 text-app-text-muted">{m.lmu_setup_empty_page()}</p>}</TabsContent>; })}</Tabs>{unknown.length > 0 && <details className="rounded border border-app-border p-3"><summary className="cursor-pointer font-medium">{m.lmu_setup_other_settings()} ({unknown.length})</summary><ul className="mt-2 flex flex-col gap-1">{unknown.map((id) => { const setting = document.settings.get(id)!; return <li key={id} className="text-app-subtext">{id}: {setting.display || m.lmu_setup_no_display()} · {m.lmu_setup_index()} {setting.index}</li>; })}</ul></details>}</div>;
}
