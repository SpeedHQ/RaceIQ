import { diffSVM, type SvmDocument, type SvmDiff } from "@raceiq/game-lmu-metadata/setups/svm";
import { getSvmFieldDescriptor } from "@raceiq/game-lmu-metadata/setups/fields";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface LmuSetupCompareProps { a: SvmDocument | null; b: SvmDocument | null; onExplain?: (parameterId: string) => void }

function diffKind(kind: SvmDiff["kind"]): string {
  if (kind === "changed") return m.lmu_setup_diff_changed();
  if (kind === "added") return m.lmu_setup_diff_added();
  return m.lmu_setup_diff_removed();
}

function describeField(entry: SvmDiff): { text: string; parameterId?: string } {
  const descriptor = getSvmFieldDescriptor(entry.id);
  if (!descriptor) return { text: entry.id };
  const pageLabels: Record<string, string> = {
    basic: m.lmu_setup_page_basic(), powertrain: m.lmu_setup_page_powertrain(), wheels: m.lmu_setup_page_wheels(),
    suspension: m.lmu_setup_page_suspension(), dampers: m.lmu_setup_page_dampers(), chassis: m.lmu_setup_page_chassis(),
  };
  const fields: Record<string, string> = {
    "GENERAL.FuelSetting": m.lmu_setup_field_general_fuel(), "GENERAL.FuelCapacitySetting": m.lmu_setup_field_general_fuel_capacity(), "GENERAL.VirtualEnergySetting": m.lmu_setup_field_general_virtual_energy(),
    "CONTROLS.RearBrakeSetting": m.lmu_setup_field_controls_rear_brake(), "CONTROLS.SteerLockSetting": m.lmu_setup_field_steer_lock(), "CONTROLS.BrakePressureSetting": m.lmu_setup_field_brake_pressure(),
    "REARWING.RWSetting": m.lmu_setup_field_rearwing(), "SUSPENSION.FrontAntiSwaySetting": m.lmu_setup_field_front_arb(), "SUSPENSION.RearAntiSwaySetting": m.lmu_setup_field_rear_arb(),
    "FRONTLEFT.PressureSetting": m.lmu_setup_field_pressure(), "FRONTRIGHT.PressureSetting": m.lmu_setup_field_pressure(), "REARLEFT.PressureSetting": m.lmu_setup_field_pressure(), "REARRIGHT.PressureSetting": m.lmu_setup_field_pressure(),
    "FRONTLEFT.CamberSetting": m.lmu_setup_field_camber(), "FRONTRIGHT.CamberSetting": m.lmu_setup_field_camber(), "REARLEFT.CamberSetting": m.lmu_setup_field_camber(), "REARRIGHT.CamberSetting": m.lmu_setup_field_camber(),
    "FRONTLEFT.SpringSetting": m.lmu_setup_field_spring(), "FRONTRIGHT.SpringSetting": m.lmu_setup_field_spring(), "REARLEFT.SpringSetting": m.lmu_setup_field_spring(), "REARRIGHT.SpringSetting": m.lmu_setup_field_spring(),
    "FRONTLEFT.RideHeightSetting": m.lmu_setup_field_ride_height(), "FRONTRIGHT.RideHeightSetting": m.lmu_setup_field_ride_height(), "REARLEFT.RideHeightSetting": m.lmu_setup_field_ride_height(), "REARRIGHT.RideHeightSetting": m.lmu_setup_field_ride_height(),
  };
  const groups: Record<string, string> = {
    "Virtual Energy": m.lmu_setup_group_basic_virtual_energy(), Engine: m.lmu_setup_group_powertrain_engine(), Electronics: m.lmu_setup_group_basic_electronics(), Differential: m.lmu_setup_group_powertrain_differential(),
    Gearing: m.lmu_setup_group_powertrain_gearing(), "Front Wheels": m.lmu_setup_group_wheels_front_wheels(), "Rear Wheels": m.lmu_setup_group_wheels_rear_wheels(), Brakes: m.lmu_setup_group_wheels_brakes(),
    "Front Suspension": m.lmu_setup_group_suspension_front_suspension(), "Rear Suspension": m.lmu_setup_group_suspension_rear_suspension(), "Front Chassis": m.lmu_setup_group_chassis_front_chassis(), "Rear Chassis": m.lmu_setup_group_chassis_rear_chassis(),
  };
  const params: Record<string, string> = {
    "FRONTLEFT.PressureSetting": "pressure", "FRONTRIGHT.PressureSetting": "pressure", "REARLEFT.PressureSetting": "pressure", "REARRIGHT.PressureSetting": "pressure",
    "FRONTLEFT.CamberSetting": "camber", "FRONTRIGHT.CamberSetting": "camber", "REARLEFT.CamberSetting": "camber", "REARRIGHT.CamberSetting": "camber",
    "SUSPENSION.FrontToeInSetting": "toe", "SUSPENSION.RearToeInSetting": "toe", "SUSPENSION.FrontAntiSwaySetting": "arbF", "SUSPENSION.RearAntiSwaySetting": "arbR",
    "FRONTLEFT.SpringSetting": "springF", "FRONTRIGHT.SpringSetting": "springF", "REARLEFT.SpringSetting": "springR", "REARRIGHT.SpringSetting": "springR",
    "FRONTLEFT.RideHeightSetting": "rideHeightF", "FRONTRIGHT.RideHeightSetting": "rideHeightF", "REARLEFT.RideHeightSetting": "rideHeightR", "REARRIGHT.RideHeightSetting": "rideHeightR",
    "GENERAL.FuelSetting": "fuelRatio", "GENERAL.VirtualEnergySetting": "virtualEnergy", "CONTROLS.RearBrakeSetting": "brakeBias", "CONTROLS.BrakePressureSetting": "brakePressure",
    "ENGINE.RegenerationMapSetting": "regen", "ENGINE.ElectricMotorMapSetting": "motorMap", "DRIVELINE.DiffPowerSetting": "diffPower", "DRIVELINE.DiffCoastSetting": "diffCoast", "DRIVELINE.DiffPreloadSetting": "diffPreload",
  };
  const page = pageLabels[descriptor.pageId] ?? descriptor.pageName;
  const group = groups[descriptor.group] ?? descriptor.group;
  const label = fields[entry.id] ?? descriptor.label;
  const corner = descriptor.axle ? ` (${descriptor.axle})` : "";
  const parameterId = params[entry.id];
  return { text: `${page} · ${group} · ${label}${corner}`, ...(parameterId ? { parameterId } : {}) };
}

export function LmuSetupCompare({ a, b, onExplain }: LmuSetupCompareProps) {
  if (!a || !b) return <p className="rounded border border-app-border p-4 text-app-text-muted">{m.lmu_setup_compare_select_two()}</p>;
  const different = (a.carId && b.carId ? a.carId !== b.carId : a.carName.toLowerCase() !== b.carName.toLowerCase()) || a.className !== b.className;
  const diff = diffSVM(a, b);
  return <div className="flex flex-col gap-4">
    {different && <p role="note" className="rounded border border-status-warning/40 bg-status-warning/10 p-3 text-app-subtext">{m.lmu_setup_different_cars()}</p>}
    {!diff.length ? <p className="rounded border border-app-border p-4 text-app-text-muted">{m.lmu_setup_compare_equal()}</p> : <Table>
      <TableHeader><TableRow><TableHead>{m.lmu_setup_compare_field()}</TableHead><TableHead>{m.lmu_setup_compare_change()}</TableHead><TableHead>{m.lmu_setup_compare_before()}</TableHead><TableHead>{m.lmu_setup_compare_after()}</TableHead><TableHead>{m.lmu_setup_compare_explain()}</TableHead></TableRow></TableHeader>
      <TableBody>{diff.map((entry) => { const field = describeField(entry); return <TableRow key={entry.id}>
        <TableCell>{field.text}<div className="text-app-caption text-app-text-muted">{entry.id}</div></TableCell>
        <TableCell><Badge variant={entry.kind === "changed" ? "info" : "warning"}>{diffKind(entry.kind)}</Badge></TableCell>
        <TableCell>{entry.before ? <>{entry.before.display || m.lmu_setup_no_display()} · {m.lmu_setup_index()} {entry.before.index}</> : "—"}</TableCell>
        <TableCell>{entry.after ? <>{entry.after.display || m.lmu_setup_no_display()} · {m.lmu_setup_index()} {entry.after.index}</> : "—"}</TableCell>
        <TableCell>{onExplain && field.parameterId ? <Button variant="link" size="sm" onClick={() => onExplain(field.parameterId!)}>{m.lmu_setup_parameter_explanation()}</Button> : "—"}</TableCell>
      </TableRow>; })}</TableBody>
    </Table>}
  </div>;
}
